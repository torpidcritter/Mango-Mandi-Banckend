import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Backend-free walk through every screen against the mocked API.

test('Today shows tiles, aging batches and low stock', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/today')
  await expect(page.getByRole('link', { name: /3\s*Confirmed/ })).toHaveAttribute('href', '/orders?status=CONFIRMED')
  await expect(page.getByRole('link', { name: /2\s*Open claims/ })).toBeVisible()
  await expect(page.getByText(/Last updated \d\d:\d\d IST/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Alphonso batch, 7 days old/ })).toBeVisible()
  await expect(page.getByText('Alphonso 5kg Box')).toBeVisible()
})

test('Today: Needs attention appears only when something is wrong, and a failed message can be sent again', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toHaveCount(0)

  api.attention = {
    loop: { lastRunAt: '2026-10-15T04:00:00Z', stale: true, failingSteps: [{ step: 'refunds', since: '2026-10-15T04:00:00Z', error: 'Razorpay 503' }] },
    failedMessages: [
      { id: 'ntf1', kind: 'ORDER_CONFIRMED', phone: '9876••••10', error: 'WhatsApp 400: template not approved', attempts: 6, createdAt: '2026-10-15T03:00:00Z', order: { id: 'o1', number: 'ORD-1042' }, preorderNumber: null },
    ],
    stuckRefunds: [{ type: 'order', id: 'o2', number: 'ORD-1040', requestedAt: '2026-10-15T02:00:00Z' }],
    webhookFailures: [{ id: 'w1', source: 'razorpay', reason: "payment.captured for an order we don't have (order_x)", eventKey: 'evt_1', createdAt: '2026-10-15T03:30:00Z' }],
  }
  await page.reload()
  const card = page.getByRole('region', { name: 'Needs attention' })
  await expect(card).toContainText('The background loop has stopped.')
  await expect(card).toContainText('Sending refunds is failing')
  await expect(card).toContainText('Refund not sent for ORD-1040')
  await expect(card).toContainText('template not approved')
  await expect(card).toContainText('Razorpay webhook problem')
  await card.getByRole('button', { name: 'Send again for ORD-1042' }).click()
  await expect(page.getByText('Message queued to send again')).toBeVisible()
  expect(api.calls.some((c) => c.method === 'POST' && c.path === '/notifications/ntf1/retry')).toBe(true)
})

test('Batches lists batches, flags missing QC, and filters by status in the URL', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/batches')
  await expect(page.getByText('No QC: not sellable yet')).toBeVisible()
  await page.getByRole('button', { name: 'Selling', exact: true }).click()
  await expect(page).toHaveURL(/status=SELLING/)
})

test('Receive batch posts the SKU quantities and opens the new batch', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/batches')
  await page.getByRole('button', { name: 'Receive batch' }).click()
  const dialog = page.getByRole('dialog', { name: 'Receive batch' })
  await dialog.getByLabel(/Alphonso 3kg Box/).fill('20')
  await dialog.getByRole('button', { name: 'Receive batch' }).click()
  await expect(page).toHaveURL(/\/batches\/b-new\?focusQC=1/)
  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/batches')
  expect(post?.body).toMatchObject({ variety: 'Alphonso', lines: [{ sku: 'ALP-3', onHand: 20 }] })
})

test('Batch detail: stock, QC warning, ledger and manager condemn', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/batches/b1')
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to Exhausted' })).toBeVisible()

  await page.getByLabel('Ripe', { exact: true }).check()
  await page.getByLabel('Good').check()
  await page.getByRole('button', { name: 'Log QC' }).click()
  await expect(page.getByText(/QC already logged today/)).toBeVisible()
  expect(api.calls.find((c) => c.path === '/batches/b1/qc')?.body).toMatchObject({ ripenessRating: 'RIPE', condition: 'GOOD' })

  await page.getByRole('tab', { name: 'Ledger' }).click()
  await expect(page.getByText('+20')).toBeVisible()

  await page.getByRole('button', { name: 'Condemn batch' }).click()
  await page.getByRole('button', { name: 'Condemn and move orders' }).click()
  const result = page.getByRole('dialog', { name: 'Batch condemned' })
  await expect(result).toContainText('moved to other batches')
  await expect(result).toContainText('ORD-1042')
  await expect(result).toContainText('ORD-1043')
})

test('Operators see condemn disabled with the manager hint', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/batches/b1')
  const condemn = page.getByRole('button', { name: /Condemn batch/ })
  await expect(condemn).toBeDisabled()
  await expect(condemn).toHaveAttribute('title', 'Requires manager role')
})

test('Adjust stock requires a reason', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/batches/b1')
  await page.getByRole('button', { name: 'Adjust ALP-3' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('On hand').fill('18')
  await dialog.getByRole('button', { name: 'Save adjustment' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('A reason is required.')
  await dialog.getByLabel('Reason').fill('2 crushed')
  await dialog.getByRole('button', { name: 'Save adjustment' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/batches/b1/lines/l1')?.body).toEqual({ onHand: 18, reason: '2 crushed' })
})

test('Orders list filters and opens a detail page', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders')
  await expect(page.getByText('2 orders · page 1 of 1')).toBeVisible()
  await page.getByLabel('Search order number or phone').fill('ORD-1042')
  await expect(page).toHaveURL(/q=ORD-1042/)
  await page.getByRole('button', { name: 'Open order ORD-1042' }).click()
  await expect(page).toHaveURL(/\/orders\/o1$/)
})

test('Order detail: mark packed waits for allocation; cancel needs a reason', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/orders/o1')
  await expect(page.getByRole('button', { name: 'Mark packed (allocate first)' })).toBeDisabled()
  await page.getByRole('button', { name: 'Allocate and pack' }).click()
  await expect.poll(() => api.calls.some((c) => c.path === '/orders/o1/allocate')).toBe(true)

  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Stock held for this order will be released.')
  await expect(dialog).not.toContainText(/refund/i)
  const confirm = dialog.getByRole('button', { name: 'Cancel order' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Reason').fill('Customer asked')
  await confirm.click()
  await expect.poll(() => api.calls.find((c) => c.path === '/orders/o1/cancel')?.body).toEqual({ reason: 'Customer asked' })
})

test('Orders never offer a refund', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders/o2')
  await expect(page.getByRole('heading', { name: 'Order ORD-1043' })).toBeVisible()
  await expect(page.getByRole('button', { name: /refund/i })).toHaveCount(0)
})

test('the order page shows the proof of delivery with the rider photo', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders/o2')
  const proof = page.locator('section', { has: page.getByRole('heading', { name: 'Proof of delivery' }) })
  await expect(proof).toContainText('Left with Security at the gate, with a photo')
  await expect(proof).toContainText('by rider@mandimangoes.test')
  await expect(proof.getByRole('link', { name: 'where' })).toHaveAttribute('href', /18\.9438,72\.8231/)
  await expect(proof.getByRole('img', { name: 'Delivery photo taken by the rider' })).toBeVisible()
})

test('Pack list: by order with allocate shortcut, by batch with unallocated section', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/pack-list?date=2026-10-16')
  await expect(page.getByRole('link', { name: 'ORD-1042' })).toBeVisible()
  await expect(page.locator('.pack-order').first()).toContainText('Morning')
  await expect(page.getByRole('button', { name: 'Allocate and pack ORD-1042' })).toBeVisible()
  await page.getByRole('button', { name: 'By batch' }).click()
  await expect(page).toHaveURL(/view=batch/)
  await expect(page.getByRole('heading', { name: 'Not allocated yet' })).toBeVisible()
})

test('Claims: start review and resolve as replacement', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/claims')
  await expect(page.getByRole('img', { name: "Customer's photo 1" })).toBeVisible()
  await page.getByRole('button', { name: 'Start review for ORD-1043' }).click()
  await expect.poll(() => api.calls.some((c) => c.path === '/claims/c1/review')).toBe(true)
  await page.getByRole('button', { name: 'Resolve ORD-1043' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/refund/i)).toHaveCount(0)
  await dialog.getByLabel(/Replacement/).check()
  await dialog.getByRole('button', { name: 'Approve replacement' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/claims/c2/resolve')?.body).toEqual({ resolution: 'REPLACEMENT_APPROVED' })
})

test('Pincodes: add validates six digits; operators cannot delete', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/pincodes')
  await expect(page.getByRole('button', { name: 'Delete 400001' })).toBeDisabled()
  await page.getByRole('button', { name: 'Add pincode' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Pincode').fill('4000')
  await dialog.getByLabel('City').fill('Mumbai')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Pincode must be exactly 6 digits.')
  await dialog.getByLabel('Pincode').fill('400050')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => api.calls.find((c) => c.method === 'POST' && c.path === '/pincodes')?.body).toEqual({ pincode: '400050', city: 'Mumbai' })
})

test('Dialogs close on Escape and return focus', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/pincodes')
  const open = page.getByRole('button', { name: 'Add pincode' })
  await open.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(open).toBeFocused()
})

test('Order detail: move delivery date posts the new date and slot', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/orders/o1')
  await expect(page.getByText('Morning 07:00–11:00')).toBeVisible()
  await page.getByRole('button', { name: 'Move delivery date' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move order ORD-1042' })
  await dialog.getByLabel('New delivery date').fill('2026-12-01')
  await expect(dialog.getByLabel('Delivery slot')).toHaveValue('slt1')
  await dialog.getByLabel('Delivery slot').selectOption({ label: 'Evening (16:00–20:00)' })
  await dialog.getByRole('button', { name: 'Move order' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.path === '/orders/o1/reschedule')?.body).toEqual({ deliveryDate: '2026-12-01', slotId: 'slt2' })
})

test('Order detail lists the WhatsApp updates sent to the customer', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders/o1')
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'WhatsApp updates' }) })
  await expect(card).toContainText('Order confirmed')
  await expect(card).toContainText('Sent')
  await expect(page.getByText('WhatsApp chat')).toBeVisible()
})

test('Planning: managers add and switch off delivery slots', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/planning')
  await expect(page.getByText('Booked: Morning 12 of 40 boxes · Evening 3 boxes')).toBeVisible()
  const table = page.getByRole('region', { name: 'Delivery slots' })
  await expect(table.getByRole('row', { name: /Morning/ })).toContainText('07:00–11:00')

  await page.getByRole('button', { name: 'Add slot' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a delivery slot' })
  await dialog.getByLabel('Name').fill('Late')
  await dialog.getByLabel('Starts').fill('20:00')
  await dialog.getByLabel('Ends').fill('19:00')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The slot must end after it starts.')
  await dialog.getByLabel('Ends').fill('22:00')
  await dialog.getByLabel('Boxes per day (optional)').fill('10')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'POST' && c.path === '/slots')?.body).toEqual({ label: 'Late', startsAt: '20:00', endsAt: '22:00', maxBoxes: 10 })
  await expect(table.getByRole('row', { name: /Late/ })).toBeVisible()

  await page.getByRole('button', { name: 'Switch off Evening' }).click()
  await expect.poll(() => api.calls.find((c) => c.method === 'PATCH' && c.path === '/slots/slt2')?.body).toEqual({ active: false })
})

test('Planning: coverage gaps, closing a day, and manager-only rules', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/planning')
  const grid = page.getByRole('region', { name: /^Stock for/ })
  await expect(grid.getByRole('row', { name: /Alphonso 3kg Box/ })).toContainText('12')
  await expect(grid.getByText('none')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Delivery calendar' })).toContainText('Diwali')

  await page.getByRole('button', { name: 'Change a day' }).click()
  const day = page.getByRole('dialog', { name: 'Change a delivery day' })
  await day.getByLabel('Date').fill('2026-11-01')
  await day.getByLabel('Note (optional)').fill('Bandh')
  await day.getByRole('button', { name: 'Save' }).click()
  await expect(day).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/calendar/2026-11-01')?.body).toEqual({ isOpen: false, maxBoxes: null, note: 'Bandh' })

  await page.getByRole('button', { name: 'Edit rules' }).click()
  const rules = page.getByRole('dialog', { name: 'Edit selling rules' })
  await rules.getByLabel('Order cutoff (hour, IST)').fill('17')
  await rules.getByRole('button', { name: 'Save as new version' }).click()
  await expect(rules).toHaveCount(0)
  await expect(page.getByText('Version 4', { exact: true })).toBeVisible()
  expect((api.calls.find((c) => c.method === 'PUT' && c.path === '/config')?.body as { rules: { cutoffHourIST: number } }).rules.cutoffHourIST).toBe(17)
})

test('Preorders: weekly capacity, bookings by state, and setting capacity', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/preorders')
  const cap = page.getByRole('region', { name: 'Weekly capacity' })
  await expect(cap.getByRole('row', { name: /Alphonso 3kg Box/ })).toContainText('100')
  const list = page.getByRole('region', { name: 'Preorders' })
  await expect(list.getByRole('row', { name: /PRE-1001/ })).toContainText('Moved once: no stock')
  await expect(list.getByRole('link', { name: 'ORD-1042' })).toBeVisible()
  await page.getByRole('button', { name: 'Waitlist', exact: true }).click()
  await expect(page).toHaveURL(/status=WAITLISTED/)
  await expect(page.getByText('No preorders here.')).toBeVisible()

  await page.getByRole('button', { name: 'Set capacity' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set preorder capacity' })
  await dialog.getByLabel('Week starting (Monday)').fill('2027-03-02')
  await dialog.getByLabel('Boxes').fill('80')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Pick the Monday the week starts on.')
  await dialog.getByLabel('Week starting (Monday)').fill('2027-03-08')
  await dialog.getByLabel('Product').selectOption({ label: 'Kesar 3kg Box' })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/preorder-capacity/2027-03-08/KES-3')?.body).toEqual({ capacity: 80 })
})

test('Operators cannot set preorder capacity', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/preorders')
  await expect(page.getByRole('button', { name: /Set capacity/ })).toBeDisabled()
})

test("Planning: moving a day's orders checks first, then lists what didn't move", async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/planning')
  await page.getByRole('button', { name: "Move a day's orders" }).click()
  const dialog = page.getByRole('dialog', { name: "Move a day's orders" })
  await dialog.getByLabel('Move orders from').fill('2026-10-17')
  await dialog.getByLabel('To', { exact: true }).selectOption('2026-10-16')
  await dialog.getByLabel('Only these pincodes (optional)').fill('400001, 4000')
  await dialog.getByLabel('Reason').fill('Heavy rain')
  await dialog.getByRole('button', { name: 'Check orders' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Pincodes must be 6 digits, separated by commas.')
  await dialog.getByLabel('Only these pincodes (optional)').fill('400001')
  await dialog.getByRole('button', { name: 'Check orders' }).click()
  await expect(dialog.getByRole('status')).toContainText('2 confirmed orders')
  await dialog.getByRole('button', { name: 'Move 2 orders' }).click()
  const done = page.getByRole('dialog', { name: 'Orders moved' })
  await expect(done).toContainText('1 of 2 orders moved')
  await expect(done.getByRole('link', { name: 'ORD-1044' })).toHaveAttribute('href', '/orders/o3')
  const moves = api.calls.filter((c) => c.path === '/orders/bulk-reschedule')
  expect(moves.map((c) => c.body)).toEqual([
    { fromDate: '2026-10-17', toDate: '2026-10-16', reason: 'Heavy rain', pincodes: ['400001'], dryRun: true },
    { fromDate: '2026-10-17', toDate: '2026-10-16', reason: 'Heavy rain', pincodes: ['400001'] },
  ])
})

test('Deliveries: the rider run by slot and pincode, flagging unpacked orders', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/deliveries?date=2026-10-16')
  await expect(page.getByText('2 orders, 3 boxes. Every order is paid: riders collect nothing.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Morning · 07:00–11:00' })).toBeVisible()
  const stop = page.getByRole('list', { name: 'Morning · 07:00–11:00, 400001' })
  await expect(stop.getByRole('listitem', { name: 'ORD-1042' })).toContainText('12 Marine Drive')
  await expect(stop.getByRole('listitem', { name: 'ORD-1044' })).toContainText('Not packed yet')
  await expect(stop.getByRole('link', { name: '9876543210' })).toHaveAttribute('href', 'tel:+919876543210')
  await expect(stop.getByRole('link', { name: 'Map for ORD-1042' })).toHaveAttribute('href', /google\.com\/maps\/search\/.*12%20Marine%20Drive%20400001/)
  expect(api.calls.some((c) => c.path === '/manifest')).toBe(true)
})

test('a rider starts the run and proves each delivery with the code, or says why it failed', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 18.9438, longitude: 72.8231 })
  await page.goto('/')
  await expect(page).toHaveURL(/\/deliveries/)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Deliveries' })).toBeVisible()
  for (const name of ['Today', 'Orders', 'Pack list', 'Staff']) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0)
  await expect(nav).toContainText('rider@mandimangoes.test · Rider')

  await page.goto('/deliveries?date=2026-10-16')
  const stop = page.getByRole('list', { name: 'Morning · 07:00–11:00, 400001' })
  // Riders don't open the staff order page.
  await expect(stop.getByRole('link', { name: 'ORD-1042' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start run Morning · 07:00–11:00 (1)' }).click()
  await expect(page.getByText('1 order out for delivery')).toBeVisible()
  await expect(page.getByText('Not sent: ORD-1044 (not packed yet)')).toBeVisible()
  expect(api.calls.find((c) => c.path === '/manifest/dispatch')?.body).toEqual({ date: '2026-10-16', slotId: 'slt1' })

  await stop.getByRole('button', { name: 'Delivered ORD-1042' }).click()
  const dialog = page.getByRole('dialog', { name: 'Deliver ORD-1042' })
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter the 4-digit code the customer gives you.')
  await dialog.getByLabel("Customer's delivery code").fill('1111')
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog.getByRole('alert')).toContainText('That code is not right. 4 tries left.')
  await dialog.getByLabel("Customer's delivery code").fill('4821')
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('ORD-1042 delivered')).toBeVisible()
  const sent = api.calls.filter((c) => c.path === '/orders/o1/delivery').map((c) => c.body)
  const at = { lat: 18.9438, lng: 72.8231 }
  expect(sent).toEqual([{ outcome: 'DELIVERED', code: '1111', ...at }, { outcome: 'DELIVERED', code: '4821', ...at }])
  await expect(stop.getByRole('listitem', { name: 'ORD-1042' })).toContainText('Delivered')
})

test('a rider records a missed delivery with a reason, and a handover with a photo', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 18.9438, longitude: 72.8231 })
  api.manifest.runs[0].stops[0].orders[0].status = 'OUT_FOR_DELIVERY'
  await page.goto('/deliveries?date=2026-10-16')
  const stop = page.getByRole('list', { name: 'Morning · 07:00–11:00, 400001' })

  await stop.getByRole('button', { name: 'Delivered ORD-1042' }).click()
  let dialog = page.getByRole('dialog', { name: 'Deliver ORD-1042' })
  await dialog.getByRole('button', { name: 'No code? Leave it with someone and take a photo' }).click()
  await dialog.getByLabel('Photo of the handover').setInputFiles({
    name: 'door.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  })
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Say who took it, or where you left it.')
  await dialog.getByLabel('Who took it, or where you left it').fill('Security at the gate')
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.filter((c) => c.path === '/orders/o1/delivery-photos')).toHaveLength(1)
  expect(api.calls.find((c) => c.path === '/orders/o1/delivery')?.body).toEqual({ outcome: 'DELIVERED', photoId: 'dph9', receivedBy: 'Security at the gate', lat: 18.9438, lng: 72.8231 })

  api.manifest.runs[0].stops[0].orders[0].status = 'OUT_FOR_DELIVERY'
  await page.reload()
  await stop.getByRole('button', { name: "Couldn't deliver ORD-1042" }).click()
  dialog = page.getByRole('dialog', { name: "Couldn't deliver ORD-1042" })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Pick what happened.')
  await dialog.getByLabel('Customer not home').check()
  await dialog.getByLabel('Note (optional)').fill('Called twice')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('ORD-1042 will be tried again on the next delivery day')).toBeVisible()
  expect(api.calls.filter((c) => c.path === '/orders/o1/delivery').at(-1)?.body).toEqual({ outcome: 'FAILED', reason: 'NOT_HOME', note: 'Called twice', lat: 18.9438, lng: 72.8231 })
})

test('Analytics: season tiles, weekly charts with hover detail, and the tables', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/analytics')
  await expect(page.locator('.tile', { hasText: 'Boxes sold' })).toContainText('72')
  await expect(page.getByText('10 of 100 received')).toBeVisible()
  await expect(page.getByText('9.5%')).toBeVisible()
  const bar = page.getByRole('group', { name: /Weekly boxes, 3 weeks, highest 52/ })
  await expect(bar).toBeVisible()
  await page.getByLabel('Week of 12 Oct: 52 boxes, 30 orders, ₹46,800').first().hover()
  await expect(page.locator('.tip').first()).toContainText('52 boxes')
  const weeks = page.getByRole('region', { name: 'Week by week' })
  await expect(weeks.getByRole('row', { name: /12 Oct/ })).toContainText('52')
  await expect(page.getByRole('region', { name: 'By product' }).getByRole('row', { name: /Alphonso 3kg Box/ })).toContainText('10%')
})

test('Operators cannot edit selling rules', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/planning')
  await expect(page.getByRole('button', { name: /Edit rules/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Move a day's orders/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Add slot/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Switch off Morning/ })).toBeDisabled()
})

for (const path of ['/today', '/batches', '/batches/b1', '/orders', '/orders/o1', '/pack-list', '/deliveries', '/claims', '/pincodes', '/planning', '/preorders', '/analytics', '/promos', '/products', '/zones', '/campaigns']) {
  test(`${path} has no horizontal page scroll`, async ({ page }) => {
    await mockApi(page, { signedIn: true })
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}

test('a packer sees only the pack list, deliveries and order steps', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/')
  await expect(page).toHaveURL(/\/pack-list/)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Pack list' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Deliveries' })).toBeVisible()
  for (const name of ['Today', 'Batches', 'Orders', 'Claims', 'Pincodes', 'Planning', 'Staff']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0)
  }
  await expect(nav).toContainText('packer@mandimangoes.test · Packer')

  await page.goto('/orders/o1')
  await expect(page.getByRole('heading', { name: /^Order ORD-1042/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Move delivery date' })).toHaveCount(0)

  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to your home screen' }).click()
  await expect(page).toHaveURL(/\/pack-list/)
})

test('QC staff land on batches and see nothing else', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'QC' })
  await page.goto('/')
  await expect(page).toHaveURL(/\/batches/)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Batches' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Pack list' })).toHaveCount(0)
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
})

test('Staff: a manager adds a packer, changes a role and reads the activity log', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/staff')
  await expect(page.getByRole('heading', { name: 'Staff', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Role for manager@mandimangoes.test')).toBeDisabled()

  await page.getByRole('button', { name: 'Add person' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add person' })
  await dialog.getByLabel('Work email').fill('ravi@mandimangoes.test')
  await dialog.getByLabel('First password').fill('short')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toContainText('at least 10 characters')
  await dialog.getByLabel('First password').fill('long-enough-1')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('ravi@mandimangoes.test added as Packer')).toBeVisible()
  expect(api.calls.find((c) => c.method === 'POST' && c.path === '/staff')?.body).toEqual({ email: 'ravi@mandimangoes.test', role: 'PACKER', password: 'long-enough-1' })

  await page.getByLabel('Role for ops@mandimangoes.test').selectOption('QC')
  await expect(page.getByText('ops@mandimangoes.test is now QC. They will need to sign in again.')).toBeVisible()

  const log = page.getByRole('region', { name: 'Activity' })
  await expect(log).toContainText('Set order to Packed')
  await expect(log).toContainText('Logged QC')
  await expect(log.getByRole('link', { name: 'Open order' })).toHaveAttribute('href', '/orders/o1')
})

test('Staff is a manager-only screen', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/today')
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' })).toHaveCount(0)
  await page.goto('/staff')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
})

import { expect, test } from './fixtures'
import { mockApi, type MockState } from './mock-api'

// Safe defaults and the rider's view: stops to deliver first, and no one-click
// steps that are hard to take back.

type Stop = MockState['manifest']['runs'][number]['stops'][number]
type ManifestOrder = Stop['orders'][number]

/** A busy run: one stop out for delivery, a few delivered, one not packed yet. */
function busyRun(api: MockState) {
  const order = (n: number, status: string, packed = true): ManifestOrder => ({
    id: `x${n}`, number: `ORD-${2000 + n}`, customerName: `Customer ${n}`, phone: `98765${String(n).padStart(5, '0')}`, deliveryAddress: `${n} Carter Road`,
    status, packed, boxes: 1, attempt: 1, items: [{ sku: 'ALP-3', productName: 'Alphonso 3kg Box', stage: 'RIPE', quantity: 1 }],
  }) as ManifestOrder
  const orders = [order(1, 'DELIVERED'), order(2, 'OUT_FOR_DELIVERY'), order(3, 'DELIVERED'), order(4, 'CONFIRMED', false), order(5, 'DELIVERED')]
  api.manifest = {
    ...api.manifest,
    orders: orders.length,
    boxes: orders.length,
    runs: [{ ...api.manifest.runs[0], orders: orders.length, boxes: orders.length, stops: [{ pincode: '400050', city: 'Mumbai', zone: 'Bandra', orders }] }],
  }
}

test('a rider sees the stops to deliver first; delivered and not-packed fold away', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  busyRun(api)
  await page.goto('/deliveries?date=2026-10-16')
  await expect(page.getByRole('status', { name: 'Run summary' })).toHaveText('1 to deliver · 3 delivered · 1 not packed yet')
  const main = page.getByRole('list', { name: 'Morning · 07:00–11:00, 400050' })
  await expect(main.getByRole('listitem')).toHaveCount(1)
  const stop = main.getByRole('listitem', { name: 'ORD-2002' })
  await expect(stop.getByRole('button', { name: 'Delivered ORD-2002' })).toBeVisible()
  await expect(stop.getByRole('link', { name: 'Call ORD-2002' })).toHaveAttribute('href', 'tel:+919876500002')
  await expect(stop.getByRole('link', { name: 'Map for ORD-2002' })).toHaveAttribute('href', /google\.com\/maps/)
  // Call and Map are real buttons, big enough for a thumb.
  for (const name of ['Call ORD-2002', 'Map for ORD-2002']) {
    const box = await stop.getByRole('link', { name }).boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
  // Riders don't print.
  await expect(page.getByRole('button', { name: 'Print' })).toHaveCount(0)

  const showDone = page.getByRole('button', { name: 'Show delivered (3)' })
  await expect(showDone).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('list', { name: 'Morning · 07:00–11:00, delivered' })).toHaveCount(0)
  await showDone.click()
  const done = page.getByRole('list', { name: 'Morning · 07:00–11:00, delivered' })
  await expect(done.getByRole('listitem')).toHaveCount(3)
  await expect(done.getByRole('listitem', { name: 'ORD-2001' })).toContainText('Customer 1 · 400050')
  await page.getByRole('button', { name: 'Show not packed yet (1)' }).click()
  await expect(page.getByRole('list', { name: 'Morning · 07:00–11:00, not packed yet' }).getByRole('listitem', { name: 'ORD-2004' })).toContainText('Not packed yet')

  // Switching the view off shows every stop in full.
  await page.getByLabel('To deliver first').uncheck()
  await expect(main.getByRole('listitem')).toHaveCount(5)
})

test('staff see every stop by default, and can print', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  busyRun(api)
  await page.goto('/deliveries?date=2026-10-16')
  await expect(page.getByRole('list', { name: 'Morning · 07:00–11:00, 400050' }).getByRole('listitem')).toHaveCount(5)
  await expect(page.getByLabel('To deliver first')).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible()
})

test('an empty day offers Today, Tomorrow and the next day with deliveries', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  const full = api.manifest
  await page.route('**/admin/v1/manifest?**', (route) => {
    const d = new URL(route.request().url()).searchParams.get('date')
    const body = d === '2026-10-18' ? { ...full, date: d } : { date: d, orders: 0, boxes: 0, runs: [] }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/deliveries?date=2026-10-16')
  await expect(page.getByText('No deliveries on')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Pick a day' }).getByRole('button', { name: 'Today' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Pick a day' }).getByRole('button', { name: 'Tomorrow' })).toBeVisible()
  await page.getByRole('button', { name: /^Go to .* \(2 orders\)$/ }).click()
  await expect(page).toHaveURL(/date=2026-10-18/)
  await expect(page.getByRole('heading', { name: 'Morning · 07:00–11:00' })).toBeVisible()
})

test('switching between code and photo clears the last error', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  api.manifest.runs[0].stops[0].orders[0].status = 'OUT_FOR_DELIVERY'
  await page.goto('/deliveries?date=2026-10-16')
  await page.getByRole('button', { name: 'Delivered ORD-1042' }).click()
  const dialog = page.getByRole('dialog', { name: 'Deliver ORD-1042' })
  await dialog.getByLabel("Customer's delivery code").fill('1111')
  await dialog.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(dialog.getByRole('alert')).toContainText('That code is not right')
  await dialog.getByRole('button', { name: 'No code? Leave it with someone and take a photo' }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})

test('a failed delivery from the order page needs a reason, and sends the same report as the Deliveries page', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  api.order = { ...api.order, status: 'OUT_FOR_DELIVERY' }
  await page.goto('/orders/o1')
  await page.getByRole('button', { name: 'Delivery failed' }).click()
  const dialog = page.getByRole('dialog', { name: "Couldn't deliver ORD-1042" })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Pick what happened.')
  expect(api.calls.some((c) => c.path === '/orders/o1/status' || c.path === '/orders/o1/delivery')).toBe(false)
  await dialog.getByLabel('Address not found').check()
  await dialog.getByLabel('Note (optional)').fill('Building not on the map')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('ORD-1042 will be tried again on the next delivery day')).toBeVisible()
  expect(api.calls.find((c) => c.path === '/orders/o1/delivery')?.body).toEqual({ outcome: 'FAILED', reason: 'WRONG_ADDRESS', note: 'Building not on the map' })
  expect(api.calls.some((c) => c.path === '/orders/o1/status')).toBe(false)
})

test('marking an order as returned asks first', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.order = { ...api.order, status: 'DELIVERY_FAILED' }
  await page.goto('/orders/o1')
  await page.getByRole('button', { name: 'Mark as returned' }).click()
  const dialog = page.getByRole('dialog', { name: 'Mark ORD-1042 as returned?' })
  await dialog.getByRole('button', { name: 'Go back' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.some((c) => c.path === '/orders/o1/status')).toBe(false)
  await page.getByRole('button', { name: 'Mark as returned' }).click()
  await dialog.getByRole('button', { name: 'Mark as returned' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/orders/o1/status')?.body).toEqual({ status: 'RTO' })
})

test('Planning: resetting a calendar day asks first', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/planning')
  await page.getByRole('button', { name: /^Reset / }).click()
  const dialog = page.getByRole('dialog', { name: /^Reset .*\?$/ })
  await expect(dialog).toContainText('Diwali')
  expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false)
  await dialog.getByRole('button', { name: 'Reset day' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/calendar/2026-10-20')).toBe(true)
})

test('Batch: skipping steps asks first and names them; the next step is one click', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.batch = { ...api.batch, status: 'ARRIVING' }
  await page.goto('/batches/b1')
  await page.getByRole('button', { name: 'Skip to Selling' }).click()
  const dialog = page.getByRole('dialog', { name: 'Skip to Selling?' })
  await expect(dialog).toContainText('In transit, Arrived, Ripening')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(api.calls.some((c) => c.path === '/batches/b1/status')).toBe(false)
  await page.getByRole('button', { name: 'Move to In transit' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/batches/b1/status')?.body).toMatchObject({ status: 'IN_TRANSIT' })
})

test('Reviews: removing a reply asks first', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/reviews')
  await page.getByRole('group', { name: 'Review status' }).getByRole('button', { name: /^Published/ }).click()
  await page.getByRole('button', { name: /^Open review from/ }).first().click()
  const drawer = page.getByRole('dialog', { name: /^Review from/ })
  await drawer.getByRole('button', { name: 'Remove reply' }).click()
  const ask = drawer.getByRole('group', { name: 'Remove reply?' })
  await ask.getByRole('button', { name: 'Keep reply' }).click()
  expect(api.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/reply'))).toBe(false)
  await drawer.getByRole('button', { name: 'Remove reply' }).click()
  await ask.getByRole('button', { name: 'Yes, remove reply' }).click()
  await expect.poll(() => api.calls.some((c) => c.method === 'DELETE' && c.path === '/reviews/rvw3/reply')).toBe(true)
})

test('checkboxes and radios keep their own size', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/reviews')
  const box = await page.getByLabel('Needs attention only').boundingBox()
  expect(box!.width).toBeLessThan(24)
  expect(box!.height).toBeLessThan(24)
})

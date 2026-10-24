import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Phase 3: core journeys. A packer packs from the pack list, Today's tiles are links in the
// first screen, and detail pages show labels (not enum names), tap-to-call phones and back links.

test('a packer allocates and marks an order packed without leaving the pack list', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/pack-list?date=2026-10-16')
  const card = page.getByRole('article', { name: 'ORD-1042' })
  await expect(page.getByRole('status').filter({ hasText: 'packed' })).toHaveText('0 of 1 packed · 1 to pack')
  // Paid stock waiting to be packed reads "To pack", never "Held".
  await expect(card).toContainText('To pack')
  await expect(card).not.toContainText('Held')
  // Not every box is picked yet: allocate first; Mark packed is not offered.
  await expect(card.getByRole('button', { name: 'Mark packed ORD-1042' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Allocate stock for ORD-1042' }).click()
  await expect(page.getByText('Stock allocated for ORD-1042')).toBeVisible()

  await card.getByRole('button', { name: 'Mark packed ORD-1042' }).click()
  await expect(page.getByText('ORD-1042 packed')).toBeVisible()
  expect(api.calls.filter((c) => c.path === '/orders/o1/status').map((c) => c.body)).toEqual([{ status: 'PACKED' }])
  await expect(page).toHaveURL(/\/pack-list/)
  await expect(page.getByRole('status').filter({ hasText: 'packed' })).toHaveText('1 of 1 packed · All packed')
  await expect(card.getByRole('button')).toHaveCount(0)
})

test('pack list: a confirmed order is started and packed in one tap; "To pack" hides packed orders', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'PACKER' })
  const base = api.packList[0]
  api.packList = [
    { ...base, id: 'o5', number: 'ORD-1045', status: 'CONFIRMED', items: [{ ...base.items[0], picks: [{ ...base.items[0].picks[0], packed: true }] }] },
    { ...base, id: 'o6', number: 'ORD-1046', status: 'PACKED', items: [{ ...base.items[0], picks: [{ ...base.items[0].picks[0], packed: true }] }] },
  ]
  await page.goto('/pack-list?date=2026-10-16')
  await expect(page.getByRole('status').filter({ hasText: 'packed' })).toHaveText('1 of 2 packed · 1 to pack')
  await page.getByRole('button', { name: 'To pack', exact: true }).click()
  await expect(page).toHaveURL(/show=to-pack/)
  await expect(page.getByRole('article', { name: 'ORD-1046' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Mark packed ORD-1045' }).click()
  await expect(page.getByText('ORD-1045 packed')).toBeVisible()
  // The same steps as the order page: start processing, then packed.
  expect(api.calls.filter((c) => c.path === '/orders/o5/status').map((c) => c.body)).toEqual([{ status: 'PROCESSING' }, { status: 'PACKED' }])
  await expect(page.getByText('Everything is packed for')).toBeVisible()
})

test('Today: every tile is a link to its filtered page, urgent ones say so, and they come before Needs attention', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.summary.orders.DELIVERY_FAILED = 2
  api.attention = {
    ...api.attention,
    photoDeliveries: Array.from({ length: 31 }, (_, i) => ({
      id: `pd${i}`, method: 'staff' as const, note: 'Customer confirmed on a call', receivedBy: null, photoId: null,
      actor: 'manager@mandimangoes.test', at: '2026-10-15T08:00:00Z', order: { id: 'o1', number: `ORD-${1100 + i}`, name: 'Asha Rao' }, flags: [],
    })),
  }
  await page.goto('/today')
  const tiles = page.locator('.tiles > *')
  await expect(tiles).toHaveCount(8)
  for (const tile of await tiles.all()) {
    expect(await tile.evaluate((el) => el.tagName)).toBe('A')
    await expect(tile).toHaveAttribute('href', /^\/(orders\?status=[A-Z_]+|claims)$/)
  }
  await expect(page.getByRole('link', { name: /5\s*Payment pending/ })).toHaveAttribute('href', '/orders?status=PAYMENT_PENDING')
  await expect(page.getByRole('link', { name: /2\s*Delivery failed\s*Needs action/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /2\s*Open claims\s*Needs action/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /3\s*Confirmed/ })).not.toContainText('Needs action')

  // 31 of one kind collapse into a group of 3 with a count and "Show all".
  const card = page.getByRole('region', { name: 'Needs attention' })
  const group = card.locator('.attention-group', { hasText: 'Deliveries marked without proof' })
  await expect(group.getByRole('heading', { level: 3 })).toHaveText('Deliveries marked without proof 31')
  await expect(group.getByRole('listitem')).toHaveCount(3)

  // The tiles are in the first screen.
  const viewport = page.viewportSize()!
  const last = (await tiles.last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(viewport.height)
  const attention = (await card.boundingBox())!
  expect(attention.y).toBeGreaterThan(last.y)

  const showAll = group.getByRole('button', { name: 'Show all 31 deliveries marked without proof' })
  await showAll.click()
  await expect(group.getByRole('listitem')).toHaveCount(31)
  await expect(group.getByRole('button', { name: /Show fewer/ })).toHaveAttribute('aria-expanded', 'true')
})

test('Today: Needs attention that fails to load says so and retries, never looks calm (FE-4)', async ({ page, consoleErrors }) => {
  const api = await mockApi(page, { signedIn: true })
  api.attention = {
    ...api.attention,
    stuckRefunds: [{ type: 'order', id: 'o1', number: 'ORD-1042', requestedAt: '2026-10-15T06:00:00Z' }],
  }
  let failing = true
  await page.route('**/admin/v1/attention', (route) => (failing ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Something went wrong' } } }) : route.fallback()))
  await page.goto('/today')
  const card = page.getByRole('region', { name: 'Needs attention' })
  await expect(card.getByText('Could not load alerts.')).toBeVisible()
  await expect(card.getByRole('alert')).toBeVisible()
  // The tiles still show beside the error.
  await expect(page.locator('.tiles > *')).toHaveCount(8)

  failing = false
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect(card.getByRole('heading', { name: /Refunds not sent/ })).toBeVisible()
  await expect(card.getByText('Could not load alerts.')).toHaveCount(0)
  // The browser logs each 500 it was sent on purpose; nothing else may be logged.
  const expected = (e: string) => /Failed to load resource: the server responded with a status of 500/.test(e)
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !expected(e)))
})

/** Enum names and internal values that must never reach the screen. */
const RAW = /\b(PAYMENT_PENDING|CONFIRMED|PROCESSING|PACKED|SHIPPED|OUT_FOR_DELIVERY|DELIVERED|DELIVERY_FAILED|SEMI_RIPE|RIPE|RAW|SUCCEEDED|ORDER_CONFIRMED|INTAKE|PACK|committed|upi)\b|webhook:|\bsystem\b/

test('order detail shows labels, not enum names, and a back link', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders/o1')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Order ORD-1042' })).toBeVisible()
  expect(await main.textContent()).not.toMatch(RAW)
  await expect(main.getByRole('row', { name: /Alphonso 3kg Box/ })).toContainText('Ripe')
  await expect(main.locator('section', { hasText: 'Stock allocation' })).toContainText('To pack')
  await expect(main.getByText('by Razorpay (payment)')).toBeVisible()
  await expect(main.getByText('by System')).toBeVisible()
  await expect(main.getByText('UPI', { exact: true })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Allocate stock' })).toBeVisible()
  await expect(main.getByRole('link', { name: 'Orders', exact: true })).toHaveAttribute('href', '/orders')
})

test('a packer goes back to the pack list from an order', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/orders/o1')
  await expect(page.getByRole('main').getByRole('link', { name: 'Pack list', exact: true })).toHaveAttribute('href', '/pack-list')
})

test('batch detail: back link, ledger events by name and "Change" for the quantity', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.ledger = [
    ...api.ledger,
    { eventType: 'RELEASE', sku: 'ALP-3', delta: -1, actorType: 'admin', actorId: 'adm2', reason: null, createdAt: '2026-10-11T05:00:00Z' },
    { eventType: 'STATUS', sku: null, delta: 0, actorType: 'system', actorId: 'system', reason: 'RIPENING → SELLING', createdAt: '2026-10-12T05:00:00Z' },
  ]
  await page.goto('/batches/b1')
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: 'Batches', exact: true })).toHaveAttribute('href', '/batches')
  await main.getByRole('tab', { name: 'Ledger' }).click()
  const ledger = main.getByRole('region', { name: 'Stock ledger' })
  await expect(ledger.getByRole('columnheader', { name: 'Change' })).toBeVisible()
  await expect(ledger.getByRole('row', { name: /Received/ })).toContainText('ops@mandimangoes.test')
  // A staff id becomes the email (a manager can see the staff list); the system is named.
  await expect(ledger.getByRole('row', { name: /Released/ })).toContainText('ops@mandimangoes.test')
  await expect(ledger.getByRole('row', { name: /Status changed/ })).toContainText('Ripening → Selling')
  await expect(ledger.getByRole('row', { name: /Status changed/ })).toContainText('System')
  expect(await main.textContent()).not.toMatch(RAW)
  expect(await ledger.textContent()).not.toContain('adm2')
})

test('phone numbers are tap-to-call links on the order, claims and preorders', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/orders/o1')
  await expect(page.getByRole('link', { name: '9876543210 (call the customer)' })).toHaveAttribute('href', 'tel:+919876543210')
  await page.goto('/claims')
  await expect(page.getByRole('link', { name: '9123456780 (call the customer)' }).first()).toHaveAttribute('href', 'tel:+919123456780')
  await page.goto('/preorders')
  await expect(page.getByRole('link', { name: '+919876543210 (call Asha Rao)' })).toHaveAttribute('href', 'tel:+919876543210')
})

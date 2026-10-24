import { expect, openNavTo, test } from './fixtures'

// The §10 acceptance script against a real, seeded mango-api.
// Skips unless E2E_EMAIL / E2E_PASSWORD are set. CI runs it against mango-api.

const email = process.env.E2E_EMAIL
const password = process.env.E2E_PASSWORD

test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD and run mango-api to enable')

test('a day in the life of the warehouse', async ({ page }, testInfo) => {
  // 1. Sign in; a reload keeps the session.
  await page.goto('/login')
  await page.getByLabel('Work email').fill(email!)
  await page.getByLabel('Password').fill(password!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

  // 2. Receive an Alphonso batch; it shows "No QC" until QC is logged.
  await (await openNavTo(page, 'Batches')).click()
  await page.getByRole('button', { name: 'Receive batch' }).click()
  const dialog = page.getByRole('dialog', { name: 'Receive batch' })
  await dialog.getByLabel('Variety').selectOption('Alphonso')
  await dialog.getByRole('spinbutton').first().fill('10')
  await dialog.getByRole('button', { name: 'Receive batch' }).click()
  await expect(page).toHaveURL(/\/batches\/[^/?]+\?focusQC=1/)
  const batchUrl = page.url().split('?')[0]
  // The new batch page moves focus to its QC form once it loads; wait for that, or it would close
  // a menu opened a moment before (phone).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('form') != null)).toBe(true)
  await (await openNavTo(page, 'Batches')).click()
  await expect(page.getByText('No QC: not sellable yet').first()).toBeVisible()

  // 3. Advance the batch to Selling and log QC Ripe/Good.
  await page.goto(batchUrl)
  await page.getByRole('button', { name: 'Skip to Selling' }).click()
  await page.getByRole('dialog', { name: 'Skip to Selling?' }).getByRole('button', { name: 'Move to Selling' }).click()
  await expect(page.getByText('Batch moved to Selling')).toBeVisible()
  await page.getByLabel('Ripe', { exact: true }).check()
  await page.getByLabel('Good').check()
  await page.getByRole('button', { name: 'Log QC' }).click()
  await expect(page.getByText('QC logged', { exact: true })).toBeVisible()

  // 4–6. A customer buys from the seeded stock and pays (dev payment endpoint).
  const apiUrl = (process.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await page.request.fetch(`${apiUrl}${path}`, {
      method,
      data: body,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    })
    expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy()
    return res.status() === 204 ? null : res.json()
  }
  // Both viewports run at once, so the phone number differs per worker: two OTP
  // requests for one number would replace each other's code.
  const phone = `9${testInfo.workerIndex % 10}${String(Date.now()).slice(-8)}`
  const { devCode } = await call('POST', '/v1/auth/otp/request', { phone })
  const { accessToken: cust } = await call('POST', '/v1/auth/otp/verify', { phone, code: devCode })
  const catalogue = await call('GET', '/v1/catalogue?pincode=560034')
  const pick = catalogue.items.find((i: { qty: number }) => i.qty > 0)
  expect(pick, 'the seeded demo batches should have stock').toBeTruthy()
  await call('POST', '/v1/cart/items', { sku: pick.sku, stage: pick.stage, qty: 1 }, cust)
  // The dev API seeds Morning and Evening slots; checkout must pick one with room.
  const { slots } = await call('GET', '/v1/delivery/slots?pincode=560034')
  const slot = slots.find((x: { available: boolean }) => x.available)
  const quote = await call('POST', '/v1/checkout/quote', { pincode: '560034', ...(slot ? { slotId: slot.id } : {}) }, cust)
  const placed = await call(
    'POST',
    '/v1/checkout/confirm',
    { quoteId: quote.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', name: 'E2E Customer' },
    cust,
    { 'Idempotency-Key': `e2e-${phone}` },
  )
  await call('POST', '/v1/dev/pay', { orderId: placed.orderId, outcome: 'captured' })

  // 7–9. Ops process, allocate, pack, ship and deliver it in the panel.
  await page.goto(`/orders/${placed.orderId}`)
  await expect(page.getByRole('heading', { name: `Order ${placed.number}` })).toBeVisible()
  await page.getByRole('button', { name: 'Start processing' }).click()
  await page.getByRole('button', { name: 'Allocate stock' }).click()
  await expect(page.getByText('Stock allocated. Pick list is ready.')).toBeVisible()
  for (const label of ['Mark packed', 'Mark shipped', 'Out for delivery']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
  }
  // Without the customer's code or a photo, only a manager marks it delivered, saying why.
  await page.getByRole('button', { name: 'Mark delivered', exact: true }).click()
  const proof = page.getByRole('dialog', { name: `Mark ${placed.number} delivered without proof?` })
  await proof.getByLabel('Reason').fill('Customer confirmed on a call')
  await proof.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(page.getByRole('button', { name: 'Mark delivered', exact: true })).toHaveCount(0)
  await expect(page.getByText('No actions available.')).toBeVisible()

  // 10–12. The customer claims damage; ops approve a free replacement (MandiMangoes never refunds).
  await call('POST', '/v1/claims', { orderId: placed.orderId, issueType: 'DAMAGED', description: 'Box arrived crushed', itemSkus: [pick.sku] }, cust)
  await (await openNavTo(page, 'Claims')).click()
  await page.getByRole('button', { name: `Start review for ${placed.number}` }).click()
  await page.getByRole('button', { name: `Resolve ${placed.number}` }).click()
  await page.getByRole('dialog').getByLabel(/Replacement/).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Approve replacement' }).click()
  await page.getByRole('button', { name: 'Resolved', exact: true }).click()
  // Both viewports run at once against one API, so pick this run's claim card.
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: placed.number, exact: true }) })
  const replacement = card.locator('dd').getByRole('link', { name: /^ORD-/ })
  await expect(replacement).toBeVisible()
  await replacement.click()
  await expect(page.getByText(`Free replacement for order ${placed.number}`)).toBeVisible()

  // 13. Planning reads live coverage, the calendar and the selling rules.
  await (await openNavTo(page, 'Planning')).click()
  await expect(page.getByRole('heading', { name: 'Stock by delivery date' })).toBeVisible()
  await expect(page.getByRole('region', { name: /^Stock for/ }).first()).toBeVisible()
  await expect(page.getByText(/^Version \d+$/)).toBeVisible()
})

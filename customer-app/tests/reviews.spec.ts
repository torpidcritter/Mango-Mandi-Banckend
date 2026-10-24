import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../../tests/fixtures'

// Reviews end to end against the real API: an order is delivered, the
// customer reviews it with a photo, a manager publishes it (and the photo) in
// the staff panel, and the review shows on the product page.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'
const PANEL = process.env.PANEL_URL ?? `http://localhost:${process.env.PANEL_PORT ?? 5173}`
const PHOTO = path.join(__dirname, 'fixtures', 'mango.jpg')

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  // In CI the API is part of the job: a dead API is a failure, not a skip.
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

async function noA11yViolations(page: import('@playwright/test').Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

/** Digits as letters, so the reviewer's first name is unique per run ("Nila" + "bdhe"). */
const letters = (n: string) => n.replace(/\d/g, (d) => 'abcdefghij'[Number(d)])

test('deliver an order, review it with a photo, publish it in the panel, see it on the product page', async ({ page, request, context }, info) => {
  const phone = `6${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  const first = `Nila${letters(phone.slice(-5))}`
  const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

  // The customer orders and pays through the API; staff pack and deliver.
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  const tokens = await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })).json()
  const cat = await (await request.get(`${API}/v1/catalogue?pincode=560034`, as(tokens.accessToken))).json()
  const item = cat.items.find((i: { qty: number }) => i.qty > 0)
  expect(item, 'something in stock').toBeTruthy()
  await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, ...as(tokens.accessToken) })
  const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560034&delivery_date=${cat.deliveryDate}`, as(tokens.accessToken))).json()
  const slotId = slots.slots.find((s: { available: boolean }) => s.available)?.id ?? null
  const quote = await (await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560034', deliveryDate: cat.deliveryDate, slotId }, ...as(tokens.accessToken) })).json()
  const confirm = await request.post(`${API}/v1/checkout/confirm`, {
    data: { quoteId: quote.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', name: `${first} Kumar` },
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': `e2e-review-${phone}` },
  })
  expect(confirm.ok(), await confirm.text()).toBeTruthy()
  const { orderId } = await confirm.json()
  await request.post(`${API}/v1/dev/pay`, { data: { orderId, outcome: 'captured' } })
  const login = await (await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })).json()
  const staff = as(login.accessToken)
  for (const step of [
    () => request.patch(`${API}/admin/v1/orders/${orderId}/status`, { data: { status: 'PROCESSING' }, ...staff }),
    () => request.post(`${API}/admin/v1/orders/${orderId}/allocate`, staff),
    () => request.patch(`${API}/admin/v1/orders/${orderId}/status`, { data: { status: 'PACKED' }, ...staff }),
    () => request.post(`${API}/admin/v1/orders/${orderId}/dispatch`, staff),
    () => request.patch(`${API}/admin/v1/orders/${orderId}/status`, { data: { status: 'DELIVERED', override: true, reason: 'Test run: handed over in person' }, ...staff }),
  ]) {
    const r = await step()
    expect(r.ok(), await r.text()).toBeTruthy()
  }

  // The customer signs in on the web and writes a review from the order page.
  await page.goto(`/orders/${orderId}`)
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'How were your mangoes?' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(`^Write a review of ${item.name}`) }).click()

  await expect(page.getByRole('heading', { name: 'Write a review' })).toBeVisible()
  await page.getByRole('button', { name: 'Send review' }).click()
  await expect(page.getByRole('alert')).toContainText('Choose from 1 to 5 stars')
  // The star picker is a radio group: arrow keys move the choice.
  const overall = page.getByRole('radiogroup', { name: 'Your rating' })
  await overall.getByRole('radio', { name: /^1 star/ }).focus()
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await expect(overall.getByRole('radio', { name: /^5 stars/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('radiogroup', { name: 'Ripe as promised?' }).getByRole('radio', { name: /^4 stars/ }).click()
  await page.getByLabel('Tell other buyers about them (optional)').fill('Ripe on day two, sweet and fragrant. Will order again.')
  await expect(page.getByText(/946 characters left/)).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(PHOTO)
  await expect(page.getByRole('img', { name: 'Your photo 1' })).toBeVisible()
  await expect(page.getByText(`Shown as ${first} K.`)).toBeVisible()
  await noA11yViolations(page)
  if (info.project.name === 'desktop') await page.screenshot({ path: 'test-results-shop/reviews-01-form.png', fullPage: true })
  await page.getByRole('button', { name: 'Send review' }).click()
  await expect(page.getByRole('heading', { name: 'Thank you for your review' })).toBeVisible()
  await expect(page.getByText('It is under review.')).toBeVisible()

  // Not public yet.
  const before = await (await request.get(`${API}/v1/products/${item.sku}/reviews?limit=20`)).json()
  expect(JSON.stringify(before)).not.toContain(first)

  // A manager publishes it, with the photo, in the staff panel.
  const panel = await context.newPage()
  await panel.goto(`${PANEL}/login`)
  await panel.getByLabel('Work email').fill('manager@mandimangoes.test')
  await panel.getByLabel('Password').fill('manager123')
  await panel.getByRole('button', { name: 'Sign in' }).click()
  // Reviews sits in the Customers group on desktop, and in the Menu on a phone.
  const nav = panel.getByRole('navigation', { name: 'Main' })
  await (info.project.name === 'phone' ? panel.getByRole('button', { name: 'Menu' }) : nav.getByRole('button', { name: 'Customers' })).click()
  await nav.getByRole('link', { name: 'Reviews', exact: true }).click()
  await panel.getByRole('button', { name: `Open review from ${first} K.` }).click()
  const drawer = panel.getByRole('dialog', { name: `Review from ${first} K.` })
  await expect(drawer).toContainText('Ripe on day two')
  await expect(drawer.getByRole('img', { name: "Customer's photo 1" })).toBeVisible()
  await drawer.getByLabel('Publish photo 1').check()
  if (info.project.name === 'desktop') await panel.screenshot({ path: 'test-results-shop/reviews-02-panel.png' })
  await drawer.getByRole('button', { name: 'Publish with 1 photo' }).click()
  await expect(panel.getByText('Review published')).toBeVisible()
  await drawer.getByRole('button', { name: 'Write a reply' }).click()
  await drawer.getByLabel(/Public reply/).fill(`Thank you, ${first}!`)
  await drawer.getByRole('button', { name: 'Save reply' }).click()
  await expect(drawer).toContainText(`Thank you, ${first}!`)
  await panel.close()

  // The review is on the product page, with the badge, the photo and the reply.
  await page.goto(`/mangoes/${item.sku}`)
  const card = page.getByRole('article', { name: new RegExp(`^Review by ${first} K\\., 5 out of 5 stars`) })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Verified purchase')
  await expect(card).toContainText('Reply from MandiMangoes')
  await expect(card.getByRole('button', { name: /^Open photo 1 of 1/ })).toBeVisible()
  await noA11yViolations(page)
  await card.getByRole('button', { name: /^Open photo 1 of 1/ }).click()
  const box = page.getByRole('dialog', { name: new RegExp(`^Photo 1 of 1 from ${first} K\\.`) })
  await expect(box.getByRole('img')).toBeVisible()
  if (info.project.name === 'desktop') await page.screenshot({ path: 'test-results-shop/reviews-04-lightbox.png' })
  await page.keyboard.press('Escape')
  if (info.project.name === 'desktop') await page.screenshot({ path: 'test-results-shop/reviews-03-product.png', fullPage: true })

  // The published photo has no metadata left.
  const photoUrl = await card.getByRole('button', { name: /^Open photo 1 of 1/ }).locator('img').getAttribute('src')
  const bytes = await (await request.get(photoUrl!)).body()
  expect(bytes.includes(Buffer.from('E2E-SECRET'))).toBe(false)
  // The public list carries nothing personal.
  const after = JSON.stringify(await (await request.get(`${API}/v1/products/${item.sku}/reviews?limit=20`)).json())
  expect(after).toContain(`${first} K.`)
  for (const leak of [phone, 'Kumar', orderId, 'Koramangala']) expect(after).not.toContain(leak)
})

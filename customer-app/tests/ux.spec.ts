import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../tests/fixtures'

// The shop side of the 23 Oct UX audit, against the real API: a help contact on every page and
// the /help and /terms pages (UX-1, UX-3), the trust line, delivery row and hold length at Pay
// (UX-3), the unpaid-order banner before Pay (UX-8), prices before a pincode (UX-5), no silent
// ripeness swap when Ripe is sold out (UX-6), what is in the box, and the reason for a
// rejected claim (UX-4).

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${where}: ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })
const phoneFor = (n: number, project: string) => `9${String(Date.now()).slice(-7)}${n}${project === 'phone' ? 1 : 2}`

async function staffToken(request: APIRequestContext) {
  const r = await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })
  expect(r.ok(), await r.text()).toBeTruthy()
  return (await r.json()).accessToken as string
}

async function customer(request: APIRequestContext, phone: string) {
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  expect(asked.ok(), await asked.text()).toBeTruthy()
  return (await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })).json()).accessToken as string
}

/** An order placed through the API, paid unless `paid` is false. */
async function placeOrder(request: APIRequestContext, token: string, key: string, paid = true) {
  const cat = await (await request.get(`${API}/v1/catalogue?pincode=560034`)).json()
  const item = cat.items.find((i: { qty: number }) => i.qty > 0)
  expect(item, 'something in stock').toBeTruthy()
  await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, ...as(token) })
  const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560034&delivery_date=${cat.deliveryDate}`)).json()
  const slotId = slots.slots.find((s: { available: boolean }) => s.available)?.id ?? null
  const q = await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560034', deliveryDate: cat.deliveryDate, slotId }, ...as(token) })
  expect(q.ok(), await q.text()).toBeTruthy()
  const confirm = await request.post(`${API}/v1/checkout/confirm`, {
    data: { quoteId: (await q.json()).quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', name: 'Asha Rao' },
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
  })
  expect(confirm.ok(), await confirm.text()).toBeTruthy()
  const { orderId } = await confirm.json()
  if (paid) await request.post(`${API}/v1/dev/pay`, { data: { orderId, outcome: 'captured' } })
  // The API cart is emptied by the order; the browser keeps its own.
  return orderId as string
}

async function signIn(page: Page, phone: string) {
  await page.goto('/sign-in')
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeVisible()
}

async function setPincode(page: Page) {
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Pick your mangoes' })).toBeVisible()
}

/** Adds one box of whatever is in stock from a product page. */
async function addABox(page: Page) {
  const links = page.getByRole('region', { name: 'Pick your mangoes' }).getByRole('heading', { level: 3 }).getByRole('link')
  await page.goto('/')
  await expect(links.first()).toBeVisible()
  const total = await links.count()
  for (let i = 0; i < total; i++) {
    await page.goto('/')
    await links.nth(i).click()
    await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
    const add = page.getByRole('button', { name: /^Add to cart/ })
    if (!(await add.count()) || (await add.isDisabled())) {
      // Ripe sold out: nothing is chosen for the customer (UX-6). Choose the first in stock.
      const radio = page.getByRole('radio', { disabled: false }).first()
      if (!(await radio.count())) continue
      await radio.check()
    }
    await page.getByRole('button', { name: /^Add to cart/ }).click()
    return
  }
  throw new Error('no box in stock')
}

test('every page offers help; /help and /terms explain the rules and pass axe', async ({ page }) => {
  for (const path of ['/', '/cart', '/preorder', '/privacy', '/mangoes/ALP-3', '/no-such-page']) {
    await page.goto(path)
    const foot = page.getByRole('contentinfo')
    await expect(foot.getByRole('link', { name: 'Help', exact: true }), path).toHaveAttribute('href', '/help')
    await expect(foot.getByRole('link', { name: 'Terms of sale' }), path).toHaveAttribute('href', '/terms')
    // The e2e shop runs with a test help number (playwright.config.ts); production must set the real one.
    await expect(foot.getByRole('link', { name: /^Help on WhatsApp/ }), path).toHaveAttribute('href', /^https:\/\/wa\.me\/\d{11,15}/)
  }

  await page.goto('/help')
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
  await expect(page).toHaveTitle(/^Help · MandiMangoes$/)
  for (const h of ['Talk to us', 'How ordering works', 'Delivery days', 'Ripeness', 'Changing or cancelling an order', 'Something wrong with your box?']) {
    await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible()
  }
  // The live rules from the API, not a copy that can drift.
  await expect(page.getByText(/held for 10 minutes while you pay/)).toBeVisible()
  await expect(page.getByText(/within 24 hours of delivery/)).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /^\+91|^\+\d/ })).toHaveAttribute('href', /^https:\/\/wa\.me\//)
  await axe(page, '/help')

  await page.goto('/terms')
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of sale' })).toBeVisible()
  const main = page.getByRole('main')
  await expect(main).toContainText('We refund an order in full only in these two cases')
  await expect(main).toContainText('You cancel it before it is packed')
  await expect(main).toContainText('We cancel it because we cannot deliver it')
  await expect(main).toContainText('Problems are put right only with a replacement')
  await expect(main).toContainText('There is no cash on delivery')
  await axe(page, '/terms')
})

test('a first visit shows the boxes and prices; the pincode then unlocks ripeness and the cart', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Your delivery pincode')).toBeVisible()
  const list = page.getByRole('region', { name: 'Our mangoes and prices' })
  await expect(list.getByRole('listitem').first()).toBeVisible()
  await expect(list.getByRole('listitem').first()).toContainText(/₹[\d,]+/)
  await axe(page, 'home, first visit')
  // Search works before a pincode too.
  await page.getByRole('searchbox', { name: 'Search mangoes' }).fill('badami')
  await expect(page.getByRole('region', { name: 'Mangoes matching “badami”' }).getByRole('listitem')).not.toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search mangoes' }).fill('')

  await page.goto('/')
  await list.getByRole('heading', { level: 3 }).getByRole('link').first().click()
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Mango box')
  await expect(page.locator('.buy-price')).toContainText(/₹[\d,]+/)
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toHaveCount(0)
  await axe(page, 'product, no pincode')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Check delivery' }).click()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
})

test('when Ripe is sold out, no other ripeness is picked for the customer', async ({ page }) => {
  await setPincode(page)
  // Ripe sold out for every box on the shown day (the rest of the answer is real).
  await page.route('**/v1/catalogue?**', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.items = body.items.map((i: { stage: string; qty: number }) => (i.stage === 'RIPE' ? { ...i, qty: 0 } : i))
    await route.fulfill({ response: res, json: body })
  })
  await page.goto('/mangoes/ALP-3')
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
  const open = page.getByRole('radio', { disabled: false })
  test.skip((await open.count()) === 0, 'nothing but Ripe in stock today')
  await expect(page.getByText(/^Ripe is sold out for .+\. Choose another ripeness below/)).toBeVisible()
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0)
  const add = page.getByRole('button', { name: /^Add to cart/ })
  await expect(add).toBeDisabled()
  await expect(add).toHaveAccessibleDescription('Choose a ripeness above to add a box.')
  await axe(page, 'product, ripe sold out')
  await open.first().check()
  await expect(add).toBeEnabled()
  await expect(add).toHaveText(/^Add to cart · ₹/)
})

test('the product page says what is in the box once a manager fills it in', async ({ page, request }, info) => {
  const staff = await staffToken(request)
  // One box per project: the phone and desktop runs go side by side.
  const sku = info.project.name === 'phone' ? 'ALP-3' : 'BAD-3'
  const set = (body: object) => request.patch(`${API}/admin/v1/products/${sku}`, { data: body, ...as(staff) })
  expect((await set({ fruitsPerBox: 12, fruitWeightG: 250 })).ok()).toBeTruthy()
  try {
    await page.goto(`/mangoes/${sku}`)
    await expect(page.getByText('In the box: About 12 mangoes, around 250 g each')).toBeVisible()
    await setPincode(page)
    await page.goto(`/mangoes/${sku}`)
    await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
    await expect(page.getByText('In the box: About 12 mangoes, around 250 g each')).toBeVisible()
  } finally {
    await set({ fruitsPerBox: null, fruitWeightG: null })
  }
})

test('checkout warns about an unpaid order before Pay, and Pay says who takes the money', async ({ page, request }, info) => {
  const phone = phoneFor(3, info.project.name)
  const token = await customer(request, phone)
  await placeOrder(request, token, `ux-unpaid-${phone}`, false)
  await setPincode(page)
  await addABox(page)
  await signIn(page, phone)
  await page.goto('/checkout')
  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /is waiting for payment/ })).toBeVisible()
  await axe(page, 'checkout with an unpaid order')

  const address = page.getByLabel('Delivery address')
  if (await address.isVisible()) await address.fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.getByRole('radio', { disabled: false }).first().check()
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  const review = page.locator('.checkout-review')
  await expect(review.getByRole('status').filter({ hasText: /is waiting for payment/ })).toBeVisible()
  await expect(review.locator('.sum-row', { hasText: 'Delivery' })).toContainText('Free')
  await expect(review).toContainText('Your boxes are held for 10 minutes while you pay.')
  const pay = review.getByRole('button', { name: /^Pay ₹/ })
  await expect(pay).toHaveAccessibleDescription(/Secure payment by Razorpay\. UPI, cards, netbanking\./)
  await expect(review.getByRole('link', { name: 'terms of sale' })).toHaveAttribute('href', '/terms')
  await expect(review.getByRole('link', { name: 'help' })).toHaveAttribute('href', '/help')
  await axe(page, 'review and pay')
})

test('a rejected claim shows the reason staff gave', async ({ page, request }, info) => {
  const phone = phoneFor(4, info.project.name)
  const token = await customer(request, phone)
  const staff = as(await staffToken(request))
  const orderId = await placeOrder(request, token, `ux-claim-${phone}`)
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
  const claim = await request.post(`${API}/v1/claims`, { data: { orderId, issueType: 'DAMAGED', description: 'Two mangoes were crushed' }, ...as(token) })
  expect(claim.ok(), await claim.text()).toBeTruthy()
  const claimId = (await claim.json()).id
  await request.post(`${API}/admin/v1/claims/${claimId}/review`, staff)
  const bare = await request.post(`${API}/admin/v1/claims/${claimId}/resolve`, { data: { resolution: 'REJECTED' }, ...staff })
  expect(bare.status()).toBe(400)
  const reason = 'The delivery photo shows both boxes sealed and undamaged.'
  const rejected = await request.post(`${API}/admin/v1/claims/${claimId}/resolve`, { data: { resolution: 'REJECTED', reason }, ...staff })
  expect(rejected.ok(), await rejected.text()).toBeTruthy()

  await signIn(page, phone)
  await page.goto(`/orders/${orderId}`)
  const report = page.getByRole('region', { name: 'Your report' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Your report' }) }))
  await expect(report).toContainText('could not offer a replacement')
  await expect(report).toContainText(`Why: ${reason}`)
  await expect(report.getByRole('link', { name: 'talk to us' })).toHaveAttribute('href', '/help')
  await expect(page.getByText('Need help with this order?')).toBeVisible()
  await axe(page, 'order with a rejected claim')
})

import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page, Route } from '@playwright/test'
import { expect, test } from '../../tests/fixtures'

// Paying and the session, against the real API, with the outside world stood
// in for: Razorpay's checkout script is replaced by a fake that records what
// it was opened with, and the odd response (a gateway 502, a busy 503, an HTML
// error page) is injected with page.route.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

async function noA11yViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

let seq = 0
const newPhone = (first: string, project: string) => `${first}${String(Date.now()).slice(-7)}${seq++ % 10}${project === 'phone' ? 1 : 2}`

async function signIn(page: Page, phone: string, next = '/') {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeVisible()
}

/** Something in stock for the earliest day, from the real catalogue. */
async function inStock(request: APIRequestContext) {
  const cat = await (await request.get(`${API}/v1/catalogue?pincode=560034`)).json()
  const item = cat.items.find((i: { qty: number }) => i.qty > 0)
  expect(item, 'something in stock').toBeTruthy()
  return { item: item as { sku: string; stage: string; name: string; price: number }, date: cat.deliveryDate as string }
}

/** An unpaid order placed through the API for this phone. */
async function unpaidOrder(request: APIRequestContext, phone: string) {
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  const tokens = await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })).json()
  const auth = { Authorization: `Bearer ${tokens.accessToken}` }
  const { item, date } = await inStock(request)
  await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, headers: auth })
  const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560034&delivery_date=${date}`, { headers: auth })).json()
  const slotId = slots.slots.find((s: { available: boolean }) => s.available)?.id ?? null
  const quote = await (await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560034', deliveryDate: date, slotId }, headers: auth })).json()
  const c = await request.post(`${API}/v1/checkout/confirm`, {
    data: { quoteId: quote.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' },
    headers: { ...auth, 'Idempotency-Key': `e2e-${phone}` },
  })
  expect(c.ok(), await c.text()).toBeTruthy()
  return (await c.json()) as { orderId: string; razorpayOrderId: string; total: number }
}

/** Replaces Razorpay's checkout.js with a stand-in that records its options and closes at once. */
async function fakeRazorpay(page: Page) {
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.Razorpay = function (o) {
        window.__rzp = { key: o.key, order_id: o.order_id, amount: o.amount, timeout: o.timeout }
        return { on() {}, open() { setTimeout(() => o.modal.ondismiss(), 0) } }
      }`,
    }),
  )
}

/** The real response, with some fields changed. */
const patchJson = (patch: (body: Record<string, unknown>) => Record<string, unknown>) => async (route: Route) => {
  if (route.request().method() === 'OPTIONS') return route.continue()
  try {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: patch(await res.json()) })
  } catch {
    // The page polls; a request still in flight when the test ends is cut off.
  }
}

/** Takes the browser's own lines for responses a test sent on purpose out of the console-error check. */
const expected = (errors: string[], pattern: RegExp) => {
  for (let i = errors.length - 1; i >= 0; i--) if (pattern.test(errors[i])) errors.splice(i, 1)
}

test('FE-1: an unpaid order can be paid from another tab or device', async ({ page, request }, info) => {
  const phone = newPhone('9', info.project.name)
  const order = await unpaidOrder(request, phone)
  // A different browser context: nothing from the tab that placed the order.
  await fakeRazorpay(page)
  // The dev API has no Razorpay keys, so stand in for the key id the API returns while unpaid.
  await page.route(`${API}/v1/orders/${order.orderId}`, patchJson((b) => ({ ...b, razorpayKeyId: 'rzp_test_e2e' })))
  await signIn(page, phone, `/orders/${order.orderId}`)

  await expect(page.getByText('Waiting for your payment to be confirmed.')).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rzp?: unknown }).__rzp)).toMatchObject({
    key: 'rzp_test_e2e',
    order_id: order.razorpayOrderId,
    amount: order.total,
  })
  const { timeout } = (await page.evaluate(() => (window as unknown as { __rzp: { timeout: number } }).__rzp))
  // FE-9: the payment window closes with the hold (10 minutes at most), never later.
  expect(timeout).toBeGreaterThan(0)
  expect(timeout).toBeLessThanOrEqual(10 * 60)
})

test('FE-9: with under a minute of hold left, Pay is not offered', async ({ page, request }, info) => {
  const phone = newPhone('9', info.project.name)
  const order = await unpaidOrder(request, phone)
  await page.route(
    `${API}/v1/orders/${order.orderId}`,
    patchJson((b) => ({ ...b, razorpayKeyId: 'rzp_test_e2e', holdExpiresAt: new Date(Date.now() + 30_000).toISOString() })),
  )
  await signIn(page, phone, `/orders/${order.orderId}`)
  await expect(page.getByText('The hold on your boxes is about to end.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Pay ₹/ })).toHaveCount(0)
})

/** Waits for the delivery times, then takes the first one open (if the day has times). */
async function pickSlot(page: Page) {
  await expect(page.getByRole('radiogroup', { name: 'When should it arrive?' }).getByRole('radio', { checked: true })).toBeVisible()
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.locator('input:not([disabled])').first().check()
}

/** Signs in, fills the cart with one box and gets to the review screen. */
async function toReview(page: Page, request: APIRequestContext, phone: string) {
  const { item, date } = await inStock(request)
  await page.goto('/')
  await page.evaluate(
    ([item, date]) => {
      localStorage.setItem('mm.where', JSON.stringify({ pincode: '560034', date }))
      localStorage.setItem('mm.cart', JSON.stringify([{ sku: item.sku, stage: item.stage, qty: 1, name: item.name, price: item.price }]))
    },
    [item, date] as const,
  )
  await signIn(page, phone, '/checkout')
  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  await pickSlot(page)
  // A customer with a saved address gets it picked for them instead of the empty field.
  const field = page.getByLabel('Delivery address')
  if (await field.isVisible()) await field.fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  await page.getByRole('button', { name: 'Review order' }).click()
  // Syncing the cart and quoting is a few calls in a row: allow for a busy test API.
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible({ timeout: 15_000 })
}

test('FE-2: after a gateway error, Pay again is a fresh attempt, not the cancelled order', async ({ page, request, consoleErrors }, info) => {
  const phone = newPhone('8', info.project.name)
  const keys: string[] = []
  let quotes = 0
  await page.route(`${API}/v1/checkout/quote`, (route) => {
    if (route.request().method() === 'POST') quotes++
    return route.continue()
  })
  await page.route(`${API}/v1/checkout/confirm`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length === 1) {
      return route.fulfill({
        status: 502,
        json: { error: { code: 'PAYMENT_GATEWAY_ERROR', message: 'Could not start the payment. Please try again.' } },
      })
    }
    return route.continue()
  })
  await toReview(page, request, phone)
  expect(quotes).toBe(1)

  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await expect(page.getByRole('alert')).toContainText("We couldn't start the payment, and nothing was charged.")
  await page.getByRole('button', { name: /^Pay ₹/ }).click()

  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible()
  await expect(page.getByText('Waiting for your payment to be confirmed.')).toBeVisible()
  expect(quotes).toBe(2)
  expect(keys).toHaveLength(2)
  expect(keys[1]).not.toBe(keys[0])
  expected(consoleErrors, /status of 502/)
})

test('PAY-B3: a finished payment is handed to the API, which confirms the order at once', async ({ page, request }, info) => {
  const phone = newPhone('8', info.project.name)
  // Razorpay stand-in that "pays" and calls the success handler, signed as the dev API expects
  // (HMAC-SHA256 of order_id|payment_id with the dev stand-in for the key secret).
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.Razorpay = function (o) {
        return { on() {}, async open() {
          const enc = new TextEncoder()
          const key = await crypto.subtle.importKey('raw', enc.encode('rzp_dev_checkout_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          const sig = await crypto.subtle.sign('HMAC', key, enc.encode(o.order_id + '|pay_e2e'))
          const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
          o.handler({ razorpay_payment_id: 'pay_e2e', razorpay_order_id: o.order_id, razorpay_signature: hex })
        } }
      }`,
    }),
  )
  // The dev API has no keys: stand in for the key id, and mark the order paid at the dev gateway.
  await page.route(`${API}/v1/checkout/confirm`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    if (body.orderId) await request.post(`${API}/v1/dev/mark-paid-at-gateway`, { data: { orderId: body.orderId, outcome: 'captured' } })
    await route.fulfill({ response: res, json: { ...body, razorpayKeyId: 'rzp_test_e2e' } })
  })
  await toReview(page, request, phone)
  const verified = page.waitForResponse((r) => /\/verify-payment$/.test(r.url()) && r.request().method() === 'POST')
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  const res = await verified
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ status: 'SUCCEEDED', orderStatus: 'CONFIRMED' })
  expect(res.request().postDataJSON()).toMatchObject({ razorpay_payment_id: 'pay_e2e', razorpay_order_id: expect.stringMatching(/^order_dev_/) })
  await expect(page.getByText('Thank you, your order is placed.')).toBeVisible()
})

test('PAY-B10: a box taken off sale between review and Pay is named, and nothing is charged', async ({ page, request, consoleErrors }, info) => {
  const phone = newPhone('7', info.project.name)
  const { item } = await inStock(request)
  await page.route(`${API}/v1/checkout/confirm`, (route) =>
    route.request().method() !== 'POST'
      ? route.continue()
      : route.fulfill({ status: 409, json: { error: { code: 'PRODUCT_UNAVAILABLE', message: `${item.name} is no longer sold`, sku: item.sku, stage: item.stage } } }),
  )
  await toReview(page, request, phone)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await expect(page.getByRole('alert')).toContainText(`${item.name} is no longer sold, so we took it out of your cart. Nothing was charged.`)
  // It was the only box: the way on is back to the shop, not a Pay button for an empty cart.
  await expect(page.getByRole('button', { name: /^Pay ₹/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Choose other mangoes' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mm.cart') ?? '[]')).toBe('[]')
  expected(consoleErrors, /status of 409/)
})

test('FE-4: a payment sheet that fails to load lands on the order page, not an empty cart', async ({ page, request, consoleErrors }, info) => {
  const phone = newPhone('8', info.project.name)
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.abort())
  await page.route(`${API}/v1/checkout/confirm`, patchJson((b) => ({ ...b, razorpayKeyId: 'rzp_test_e2e' })))
  await toReview(page, request, phone)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Could not load the payment page.')
  expected(consoleErrors, /checkout\.razorpay\.com|ERR_FAILED/)
})

test('FE-7 and FE-8: changed prices are shown, a box no longer sold is named and removed, a stale day falls back', async ({ page, request }, info) => {
  const phone = newPhone('7', info.project.name)
  const { item } = await inStock(request)
  await page.goto('/')
  await page.evaluate((item) => {
    // A day long gone, a price seen weeks ago, and a box we stopped selling.
    localStorage.setItem('mm.where', JSON.stringify({ pincode: '560034', date: '2020-01-01' }))
    localStorage.setItem(
      'mm.cart',
      JSON.stringify([
        { sku: item.sku, stage: item.stage, qty: 1, name: item.name, price: item.price - 100 },
        { sku: 'GONE-9', stage: 'RIPE', qty: 1, name: 'Old Favourite Box', price: 50000 },
      ]),
    )
  }, item)
  await signIn(page, phone, '/checkout')
  await expect(page.getByRole('radiogroup', { name: 'When should it arrive?' }).getByRole('radio', { checked: true })).toBeVisible()
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  await pickSlot(page)
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('alert')).toContainText('Old Favourite Box is no longer sold, so we took it out of your cart.')

  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'A price has changed since you added it' })).toBeVisible()
  await expect(page.getByText(/^Now ₹[\d,.]+ each \(was ₹[\d,.]+\)$/)).toBeVisible()
  await noA11yViolations(page)
})

test('FE-3: a busy API does not sign the customer out; a refused refresh does', async ({ page, request, consoleErrors }, info) => {
  const phone = newPhone('6', info.project.name)
  await signIn(page, phone, '/account')
  await page.route(`${API}/v1/auth/token/refresh`, (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'BUSY', message: 'Busy, try again shortly' } } }),
  )
  await page.reload()
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('mm.profile'))).not.toBeNull()

  await page.unroute(`${API}/v1/auth/token/refresh`)
  await page.route(`${API}/v1/auth/token/refresh`, (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'INVALID_TOKEN', message: 'Sign in again' } } }),
  )
  await page.reload()
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  expected(consoleErrors, /status of 503/)
  void request
})

test('FE-5: an HTML error page from a proxy reads as a message, not a SyntaxError', async ({ page, consoleErrors }, info) => {
  const phone = newPhone('6', info.project.name)
  await signIn(page, phone, '/')
  await page.route(`${API}/v1/orders`, (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' }),
  )
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('MandiMangoes is busy right now.')
  await expect(page.getByRole('alert')).not.toContainText('JSON')
  expected(consoleErrors, /status of 502/)
})

test('a sign-out while a token refresh is on its way stays signed out', async ({ page }, info) => {
  await signIn(page, newPhone('7', info.project.name), '/')
  // The refresh answers only after the customer has signed out (seen once in CI on a busy runner).
  await page.route('**/auth/token/refresh', async (route) => {
    const res = await route.fetch()
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({ response: res })
  })
  await page.reload()
  await page.getByRole('link', { name: 'Account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.waitForTimeout(2000)
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toHaveCount(0)
})

test('FE-6: signing out forgets the saved address and cart on this device', async ({ page }, info) => {
  const phone = newPhone('6', info.project.name)
  await signIn(page, phone, '/')
  await page.evaluate(() => {
    localStorage.setItem('mm.address', JSON.stringify({ name: 'Asha Rao', address: 'Flat 4B, Lake View Apartments' }))
    localStorage.setItem('mm.cart', JSON.stringify([{ sku: 'ALP-3', stage: 'RIPE', qty: 1, name: 'Alphonso 3kg Box', price: 189900 }]))
  })
  await page.reload()
  await expect(page.getByRole('link', { name: /Cart, 1 box/ })).toBeVisible()
  await page.getByRole('link', { name: 'Account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Cart, 0 boxes/ })).toBeVisible()
  const kept = await page.evaluate(() => ({ address: localStorage.getItem('mm.address'), profile: localStorage.getItem('mm.profile'), cart: localStorage.getItem('mm.cart') }))
  expect(kept.address).toBeNull()
  expect(kept.profile).toBeNull()
  expect(kept.cart ?? '[]').toBe('[]')
})

test('FE-5: an unpaid order still on hold is pointed to from the cart and the shop', async ({ page, request }, info) => {
  const phone = newPhone('9', info.project.name)
  const order = await unpaidOrder(request, phone)
  await signIn(page, phone, '/cart')
  const banner = page.getByRole('status').filter({ hasText: 'is waiting for payment' })
  await expect(banner).toBeVisible()
  await noA11yViolations(page)
  await page.goto('/')
  await expect(banner).toBeVisible()
  await banner.getByRole('link', { name: /^Open order ORD-/ }).click()
  await expect(page).toHaveURL(new RegExp(`/orders/${order.orderId}$`))
  await expect(page.getByText('Waiting for your payment to be confirmed.')).toBeVisible()
})

test('FE-5: a second checkout while one order is unpaid links to that order', async ({ page, request }, info) => {
  const phone = newPhone('8', info.project.name)
  const first = await unpaidOrder(request, phone)
  await toReview(page, request, phone)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await expect(page.getByRole('alert')).toContainText('You have an unpaid order')
  await page.getByRole('link', { name: 'Open your unpaid order' }).click()
  await expect(page).toHaveURL(new RegExp(`/orders/${first.orderId}$`))
})

test('FE-1: a hold that ran out never says nothing was charged, keeps checking, and thanks a late payment', async ({ page, request }, info) => {
  const phone = newPhone('9', info.project.name)
  const order = await unpaidOrder(request, phone)
  let paid = false
  await page.route(
    `${API}/v1/orders/${order.orderId}`,
    patchJson((b) =>
      paid
        ? { ...b, status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', holdExpiresAt: null, cancelReason: null, cancelledAt: null }
        : { ...b, status: 'CANCELLED', paymentStatus: 'CANCELLED', holdExpiresAt: null, cancelReason: 'HOLD_EXPIRED', cancelledAt: new Date().toISOString() },
    ),
  )
  await signIn(page, phone, `/orders/${order.orderId}`)
  await expect(page.getByText("We didn't receive your payment in time.")).toBeVisible()
  await expect(page.getByText(/please don't pay again/)).toBeVisible()
  await expect(page.getByText('This page keeps checking.')).toBeVisible()
  await expect(page.getByText('Nothing was charged.')).toHaveCount(0)
  await noA11yViolations(page)
  // The late payment lands: the page notices on its own.
  paid = true
  await expect(page.getByText('Thank you, your order is placed.')).toBeVisible({ timeout: 20_000 })
})

test('P0-6: cancelling an unpaid order never says nothing was charged, since a payment may be on its way', async ({ page, request }, info) => {
  const phone = newPhone('9', info.project.name)
  const order = await unpaidOrder(request, phone)
  await signIn(page, phone, `/orders/${order.orderId}`)
  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('No payment has reached us for this order. If you have just paid, cancelling refunds it in full.')
  await expect(dialog).not.toContainText('Nothing has been charged')
  await dialog.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('This order was cancelled.')).toBeVisible()
  await expect(page.getByText('We have no payment for this order. If money has left your account, it is refunded in full.')).toBeVisible()
  await expect(page.getByText('Nothing was charged.')).toHaveCount(0)
})

test('P0-6: cancelling an unpaid booking says the same, and a second unpaid booking is refused', async ({ page, request }, info) => {
  const login = await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 15)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  const week = d.toISOString().slice(0, 10)
  const open = await request.put(`${API}/admin/v1/preorder-capacity/${week}/ALP-3`, {
    data: { capacity: 200 },
    headers: { Authorization: `Bearer ${(await login.json()).accessToken}` },
  })
  expect(open.ok(), await open.text()).toBeTruthy()
  const phone = newPhone('8', info.project.name)
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  const tokens = await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })).json()
  const bookOne = (key: string) =>
    request.post(`${API}/v1/preorders`, {
      data: { sku: 'ALP-3', stage: 'RIPE', qty: 1, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' },
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': key },
    })
  const first = await bookOne(`e2e-pre-${phone}-1`)
  expect(first.ok(), await first.text()).toBeTruthy()
  const pre = (await first.json()) as { id: string }
  const second = await bookOne(`e2e-pre-${phone}-2`)
  expect(second.status()).toBe(409)
  expect((await second.json()).error.code).toBe('UNPAID_PREORDER_EXISTS')

  await signIn(page, phone, `/preorders/${pre.id}`)
  await page.getByRole('button', { name: 'Cancel booking' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('No payment has reached us for this booking. If you have just paid, cancelling refunds it in full.')
  await expect(dialog).not.toContainText('Nothing has been charged')
  await dialog.getByRole('button', { name: 'Cancel booking' }).click()
  await expect(page.getByText('This booking was cancelled.')).toBeVisible()
  await expect(page.getByText(/We have no payment for this booking\. If money has left your account/)).toBeVisible()
  await expect(page.getByText('Nothing was charged.')).toHaveCount(0)
})

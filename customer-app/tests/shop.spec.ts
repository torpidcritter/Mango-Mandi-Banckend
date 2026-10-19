import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../../tests/fixtures'

// A customer's whole journey against the real API: pincode, pick boxes, sign in
// by code, choose a slot, pay (test payment), then cancel for a full refund.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

async function noA11yViolations(page: import('@playwright/test').Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

test('order mangoes, pay and cancel for a refund', async ({ page }, info) => {
  const phone = `9${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Mangoes picked for the day you want to eat them' })).toBeVisible()
  await noA11yViolations(page)
  await page.getByLabel('Your delivery pincode').fill('999999')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  await expect(page.getByRole('alert')).toContainText("We don't deliver to 999999 yet.")
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()

  await expect(page.getByRole('heading', { name: /^Pick your mangoes for/ })).toBeVisible()
  const dates = page.getByRole('radiogroup', { name: 'When should it arrive?' }).getByRole('radio')
  await dates.nth(1).click()
  await expect(dates.nth(1)).toHaveAttribute('aria-checked', 'true')
  await noA11yViolations(page)

  // Stock differs by day, so take whatever is in stock: two of one box, one of another.
  const adds = page.getByRole('button', { name: /^Add / })
  const first = (await adds.first().getAttribute('aria-label'))!.slice(4)
  await adds.first().click()
  await page.getByRole('button', { name: `One more ${first}` }).click()
  const second = (await adds.first().getAttribute('aria-label'))!.slice(4)
  await adds.first().click()
  await page.getByRole('link', { name: /View cart · 3 boxes/ }).click()

  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
  await page.getByRole('button', { name: `One less ${second}` }).click()
  await expect(page.getByRole('group', { name: `${second} quantity` })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign in to check out' }).click()

  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  // The session survives a reload: the refresh token is in an httpOnly cookie, nothing in localStorage.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/eyJ/)
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('alert')).toContainText('Enter the full delivery address')
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.getByRole('radio').first().check()
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Review order' }).click()

  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  await expect(page.getByText(`2 × ${first.split(', ')[0]}`)).toBeVisible()
  await page.getByRole('button', { name: /^Pay ₹/ }).click()

  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible()
  await expect(page.getByText('Waiting for your payment to be confirmed.')).toBeVisible()
  await page.getByRole('button', { name: 'Payment succeeds' }).click()
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('list', { name: 'Progress' })).toContainText('Confirmed, done')
  await noA11yViolations(page)

  await page.getByRole('link', { name: 'Cart, 0 boxes' }).waitFor()
  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText("You'll get a full refund")
  await dialog.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('This order was cancelled.')).toBeVisible()
  await expect(page.getByText(/refund of ₹[\d,]+ (has been sent|is on its way)/)).toBeVisible()

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders', exact: true }).click()
  await expect(page.getByRole('link', { name: /Order ORD-.*Cancelled/ })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
})

/** A Monday a few weeks out, past the regular booking days. */
function bookableMonday() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 15)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

test('book a box ahead, pay, then cancel for a refund', async ({ page, request }, info) => {
  // A manager opens the week for booking.
  const login = await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })
  expect(login.ok()).toBeTruthy()
  const { accessToken } = await login.json()
  const week = bookableMonday()
  const open = await request.put(`${API}/admin/v1/preorder-capacity/${week}/ALP-3`, {
    data: { capacity: 200 },
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  expect(open.ok(), await open.text()).toBeTruthy()

  const phone = `8${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  await page.goto('/')
  await page.getByRole('link', { name: 'Book a box ahead' }).click()
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Book ahead' })).toBeVisible()
  const weeks = page.getByRole('radiogroup', { name: 'Delivery week' }).getByRole('radio')
  const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', timeZone: 'UTC' }).format(new Date(`${week}T00:00:00Z`))
  await weeks.filter({ hasText: new RegExp(`^${label} `) }).first().click()
  await page.getByRole('radio', { name: /Alphonso 3kg Box/ }).check()
  await page.getByRole('radio', { name: /^Ripe/ }).check()
  await page.getByRole('button', { name: 'One box more' }).click()
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  await page.getByLabel('Pincode').fill('560034')
  await noA11yViolations(page)
  await page.getByRole('button', { name: /^Book and pay ₹/ }).click()

  await expect(page.getByRole('heading', { name: /^Booking PRE-/ })).toBeVisible()
  await expect(page.getByText('Pay to confirm your booking.')).toBeVisible()
  await expect(page.getByText('2 × Alphonso 3kg Box')).toBeVisible()
  await page.getByRole('button', { name: 'Payment succeeds' }).click()
  await expect(page.getByText(/You're booked for the week of/)).toBeVisible()
  await noA11yViolations(page)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders', exact: true }).click()
  await page.getByRole('link', { name: /Booking PRE-.*Booked/ }).click()
  await page.getByRole('button', { name: 'Cancel booking' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText("You'll get a full refund")
  await dialog.getByRole('button', { name: 'Cancel booking' }).click()
  await expect(page.getByText('This booking was cancelled.')).toBeVisible()
  await expect(page.getByText(/refund of ₹[\d,]+ (has been sent|is on its way)/)).toBeVisible()
})

test('report a damaged box with a photo', async ({ page, request }, info) => {
  // Set up a delivered order through the API: the customer orders and pays, staff pack and deliver.
  const phone = `7${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  expect(asked.ok(), await asked.text()).toBeTruthy()
  const signIn = await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })
  expect(signIn.ok(), await signIn.text()).toBeTruthy()
  const tokens = await signIn.json()
  const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })
  const cat = await (await request.get(`${API}/v1/catalogue?pincode=560034`, as(tokens.accessToken))).json()
  const item = cat.items.find((i: { qty: number }) => i.qty > 0)
  expect(item, 'something in stock').toBeTruthy()
  await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, ...as(tokens.accessToken) })
  const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560034&delivery_date=${cat.deliveryDate}`, as(tokens.accessToken))).json()
  const slotId = slots.slots.find((s: { available: boolean }) => s.available)?.id ?? null
  const q = await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560034', deliveryDate: cat.deliveryDate, slotId }, ...as(tokens.accessToken) })
  expect(q.ok(), await q.text()).toBeTruthy()
  const quote = await q.json()
  const confirm = await request.post(`${API}/v1/checkout/confirm`, {
    data: { quoteId: quote.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' },
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': `e2e-${phone}` },
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
    () => request.patch(`${API}/admin/v1/orders/${orderId}/status`, { data: { status: 'DELIVERED' }, ...staff }),
  ]) {
    const r = await step()
    expect(r.ok(), await r.text()).toBeTruthy()
  }

  // The customer signs in on the web and reports the problem with a photo.
  await page.goto(`/orders/${orderId}/claim`)
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Report a problem' })).toBeVisible()
  await page.getByLabel('Damaged or spoilt mangoes').check()
  await page.getByLabel('What happened?').fill('Two mangoes were crushed in the box.')
  // A 1×1 PNG, shrunk to a JPEG in the browser before upload.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file]').setInputFiles({ name: 'box.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByRole('img', { name: 'Photo 1' })).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByRole('heading', { name: 'Your report' })).toBeVisible()
  await expect(page.getByText('Damaged or spoilt: we are looking into it.')).toBeVisible()

  const claims = await (await request.get(`${API}/admin/v1/claims`, staff)).json()
  const mine = claims.find((c: { orderId: string }) => c.orderId === orderId)
  expect(mine.photos).toHaveLength(1)
  const pic = await request.get(`${API}/admin/v1/claims/${mine.id}/photos/${mine.photos[0].id}`, staff)
  expect(pic.headers()['content-type']).toBe('image/jpeg')
})

test('the privacy notice, and deleting an account', async ({ page }, info) => {
  const phone = `6${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  await page.goto('/sign-in')
  await page.getByRole('link', { name: 'privacy notice', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible()
  await expect(page.getByText(/in Singapore/)).toBeVisible()
  await noA11yViolations(page)

  await page.goto('/sign-in')
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account' }).click()
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible()
  await expect(page.getByText(`+91 ${phone}`)).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click()
  await expect(page.getByText('Your account is deleted.')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' })).toBeVisible()
})

test('send a gift with a promo code', async ({ page, request }, info) => {
  const login = await (await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })).json()
  const staff = { headers: { Authorization: `Bearer ${login.accessToken}` } }
  const code = `GIFT${String(Date.now()).slice(-6)}${info.project.name === 'phone' ? 1 : 2}`
  const made = await request.post(`${API}/admin/v1/promos`, { data: { code, kind: 'PERCENT', value: 10, description: 'Test offer' }, ...staff })
  expect(made.ok(), await made.text()).toBeTruthy()

  const phone = `7${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  await page.getByRole('radiogroup', { name: 'When should it arrive?' }).getByRole('radio').nth(1).click()
  await page.getByRole('button', { name: /^Add / }).first().click()
  await page.getByRole('link', { name: /View cart · 1 box/ }).click()
  await page.getByRole('button', { name: 'Sign in to check out' }).click()
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  await page.getByLabel('Your name').fill('Meera Iyer')
  await page.getByLabel('This is a gift for someone else').check()
  await page.getByLabel('Their name').fill('Kavya Rao')
  await page.getByLabel('Their mobile number').fill('9000000001')
  await page.getByLabel('A note in the box (optional)').fill('Happy Diwali!')
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.getByRole('radio').first().check()
  await page.getByLabel('Promo code (optional)').fill('NOSUCHCODE')
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('alert')).toContainText('Change or clear the promo code')
  await page.getByLabel('Promo code (optional)').fill(code)
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Review order' }).click()

  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  await expect(page.getByText(`Promo ${code}`)).toBeVisible()
  await expect(page.getByText('Kavya Rao (a gift)')).toBeVisible()
  await expect(page.getByText('Happy Diwali!')).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()
  await page.getByRole('button', { name: 'Payment succeeds' }).click()
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(`Promo ${code}`)).toBeVisible()
  await expect(page.getByText('Kavya Rao (a gift)')).toBeVisible()

  const promos = await (await request.get(`${API}/admin/v1/promos`, staff)).json()
  expect(promos.find((p: { code: string }) => p.code === code).uses).toBe(1)
})

test('reminders are a choice on the account page', async ({ page }, info) => {
  const phone = `7${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 1 : 2}`
  await page.goto('/sign-in?next=/account')
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'WhatsApp messages' })).toBeVisible()
  const remind = page.getByLabel('Remind me to order again a week after a delivery')
  await expect(remind).not.toBeChecked()
  await remind.check()
  await page.reload()
  await expect(page.getByLabel('Remind me to order again a week after a delivery')).toBeChecked()
  await expect(page.getByText(/tap "Tell me when it's back"/)).toBeVisible()
  await noA11yViolations(page)
})

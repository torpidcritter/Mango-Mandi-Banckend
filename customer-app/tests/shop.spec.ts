import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../../tests/fixtures'

// A customer's whole journey against the real API: pincode, pick boxes, sign in
// by code, choose a slot, pay (test payment), then cancel for a full refund.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'

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

/**
 * From the home page, opens the in-stock boxes in turn (skipping the first `skip` with stock),
 * adds `boxes` of the ripeness picked on the product page and returns "Name, Ripeness".
 */
async function addFromProductPage(page: import('@playwright/test').Page, boxes: number, skip: number) {
  await page.goto('/')
  const links = page.getByRole('region', { name: 'Pick your mangoes' }).getByRole('heading', { level: 3 }).getByRole('link')
  await expect(links.first()).toBeVisible()
  const total = await links.count()
  for (let i = 0; i < total; i++) {
    await page.goto('/')
    await links.nth(i).click()
    await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
    const add = page.getByRole('button', { name: /^Add to cart/ })
    // UX-6: with Ripe sold out nothing is chosen for the customer; take the first ripeness in stock.
    if (!(await page.getByRole('radio', { checked: true }).count())) {
      const inStock = page.getByRole('radio', { disabled: false })
      if (!(await inStock.count())) continue
      await inStock.first().check()
    }
    if (!(await add.count()) || (await add.isDisabled())) continue
    if (skip-- > 0) continue
    for (let n = 1; n < boxes; n++) await page.getByRole('button', { name: 'One box more' }).click()
    await add.click()
    const done = await page.getByRole('status').filter({ hasText: /^Added / }).textContent()
    return done!.match(/of (.+)\. View cart/)![1]
  }
  throw new Error('no box in stock')
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

  await expect(page.getByRole('heading', { name: 'Pick your mangoes' })).toBeVisible()
  // The delivery day is picked at checkout, not here.
  await expect(page.getByRole('radiogroup', { name: 'When should it arrive?' })).toHaveCount(0)
  await noA11yViolations(page)

  // Tapping a box opens its page, where the ripeness and count are picked. Stock differs by day, so take
  // whatever is in stock: two of one box, one of another.
  const first = await addFromProductPage(page, 2, 0)
  await noA11yViolations(page)
  const second = await addFromProductPage(page, 1, 1)
  await page.goto('/')
  await page.getByRole('link', { name: /View cart · 3 boxes/ }).click()

  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
  // The stepper is one row: minus, count, plus side by side.
  const stepper = (await page.getByRole('group', { name: `${first} quantity` }).boundingBox())!
  expect(stepper.height).toBeLessThan(60)
  expect(stepper.width).toBeLessThan(160)
  await page.getByRole('button', { name: `One less ${second}` }).click()
  await expect(page.getByRole('group', { name: `${second} quantity` })).toHaveCount(0)
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Sign in to check out' }).click()

  await expect(page.getByLabel('Mobile number')).toBeVisible()
  await noA11yViolations(page)
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
  // The row of delivery days scrolls inside itself; the page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Review order' }).click()
  // Each problem shows under its field, and the first one has focus.
  const address = page.getByLabel('Delivery address')
  await expect(address).toHaveAttribute('aria-invalid', 'true')
  await expect(address).toHaveAccessibleDescription(/Enter the full delivery address/)
  const slotGroup = page.getByRole('group', { name: 'Delivery time' })
  if (await slotGroup.count()) {
    await expect(slotGroup.getByText('Choose a delivery time.')).toBeVisible()
    await expect(slotGroup.getByRole('radio', { disabled: false }).first()).toBeFocused()
  } else {
    await expect(address).toBeFocused()
  }
  const days = page.getByRole('radiogroup', { name: 'When should it arrive?' }).getByRole('radio')
  await expect(days.first()).toHaveAttribute('aria-checked', 'true')
  if ((await days.count()) > 1) {
    // Switching day reloads its delivery times; switch back to the day the boxes were picked for.
    await days.nth(1).click()
    await expect(days.nth(1)).toHaveAttribute('aria-checked', 'true')
    await days.first().click()
    await expect(days.first()).toHaveAttribute('aria-checked', 'true')
  }
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.getByRole('radio', { disabled: false }).first().check()
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Review order' }).click()

  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  // The review is a step of its own: at the top, with focus on its heading, and in the URL.
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeFocused()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page).toHaveURL(/\/checkout\?step=review$/)
  // The browser's Back returns to the form with everything still filled in, then on again.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeFocused()
  await expect(page.getByLabel('Your name')).toHaveValue('Asha Rao')
  await expect(page.getByLabel('Delivery address')).toHaveValue('Flat 4B, Lake View Apartments, 5th Main, near the park')
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  await expect(page.getByText(`2 × ${first.split(', ')[0]}`)).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: /^Pay ₹/ }).click()

  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible()
  await expect(page.getByText('Waiting for your payment to be confirmed.')).toBeVisible()
  await page.getByRole('button', { name: 'Payment succeeds' }).click()
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible()
  // A thank-you once the payment is through; the pressed button is gone, so focus lands on it.
  const thanks = page.locator('.note-card', { hasText: 'Thank you, your order is placed.' })
  await expect(thanks).toBeVisible()
  await expect(thanks).toBeFocused()
  await expect(page.getByRole('list', { name: 'Progress' })).toContainText('Confirmed, done')
  // Change day and Cancel, with the rule for them, are in the first screen of a 375 × 812 phone.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByText("You can change the day until we start preparing it, and cancel for a full refund until it's packed.")).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change delivery day' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Cancel order' })).toBeInViewport({ ratio: 1 })
  await noA11yViolations(page)

  await page.getByRole('link', { name: 'Cart, 0 boxes' }).waitFor()
  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText("You'll get a full refund")
  // Keyboard focus stays in the dialog both ways round.
  await expect(dialog.getByRole('button', { name: 'Keep order' })).toBeFocused()
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await dialog.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('This order was cancelled.')).toBeVisible()
  // The button that opened the dialog is gone, so focus lands on the outcome.
  await expect(page.locator('.note-card', { hasText: 'This order was cancelled.' })).toBeFocused()
  await expect(page.getByText(/refund of ₹[\d,]+ (has been sent|is on its way)/)).toBeVisible()
  // The total row agrees with the refund note: "Refunded" once sent, "Paid" until then (FE-6).
  await expect
    .poll(async () => {
      const sent = await page.getByText(/refund of ₹[\d,]+ has been sent/).isVisible()
      return `${sent ? 'sent' : 'on its way'}: ${await page.locator('.total-row > span').textContent()}`
    })
    .toMatch(/^(sent: Refunded|on its way: Paid)$/)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders', exact: true }).click()
  // The card names the boxes, and a cancelled order "was due", not "arrives".
  const card = page.getByRole('link', { name: /Order ORD-.*Cancelled/ }).first()
  await expect(card).toContainText(first.split(', ')[0])
  await expect(card).toContainText('was due')
  await noA11yViolations(page)
  await page.getByRole('link', { name: 'Account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
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

  // A signed-out visitor sees the weeks and the form; signing in comes when they book.
  await expect(page.getByRole('heading', { name: 'Book ahead' })).toBeVisible()
  const weeks = page.getByRole('radiogroup', { name: 'Delivery week' }).getByRole('radio')
  await expect(weeks.first()).toBeVisible()
  const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', timeZone: 'UTC' }).format(new Date(`${week}T00:00:00Z`))
  const myWeek = weeks.filter({ hasText: new RegExp(`^${label} `) }).first()
  await myWeek.click()
  await page.getByRole('radio', { name: /Alphonso 3kg Box/ }).check()
  await page.getByRole('radio', { name: /^Ripe/ }).check()
  await page.getByRole('button', { name: 'One box more' }).click()
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByRole('button', { name: 'Sign in to book' }).click()
  // A problem shows at its field, which gets focus.
  await expect(page.getByLabel('Delivery address')).toBeFocused()
  await expect(page.getByLabel('Delivery address')).toHaveAccessibleDescription(/Enter the full delivery address/)
  await page.getByLabel('Delivery address').fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  await page.getByLabel('Pincode').fill('560034')
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Sign in to book' }).click()

  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Back on the form with every choice kept.
  await expect(page.getByRole('heading', { name: 'Book ahead' })).toBeVisible()
  await expect(myWeek).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: /^Ripe/ })).toBeChecked()
  await expect(page.getByLabel('Delivery address')).toHaveValue('Flat 4B, Lake View Apartments, 5th Main, near the park')
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
    () => request.patch(`${API}/admin/v1/orders/${orderId}/status`, { data: { status: 'DELIVERED', override: true, reason: 'Test run: handed over in person' }, ...staff }),
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
  // The delivered order says until when a problem can be reported, near the top.
  await page.goto(`/orders/${orderId}`)
  await expect(page.getByText(/^Something wrong\? Report it by .+ for a free replacement\.$/)).toBeVisible()
  await page.getByRole('link', { name: 'Report a problem with this order' }).click()
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

test('a missed delivery names the retry day, and after the last attempt says we will call', async ({ page, request }, info) => {
  // An order through the API: paid, packed and out for delivery.
  const phone = `8${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 3 : 4}`
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
  const confirm = await request.post(`${API}/v1/checkout/confirm`, {
    data: { quoteId: (await q.json()).quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' },
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
  ]) {
    const r = await step()
    expect(r.ok(), await r.text()).toBeTruthy()
  }
  const miss = async () => {
    const { attempt } = await (await request.get(`${API}/admin/v1/orders/${orderId}`, staff)).json()
    const r = await request.post(`${API}/admin/v1/orders/${orderId}/delivery`, { data: { outcome: 'FAILED', reason: 'NOT_HOME', attempt }, ...staff })
    expect(r.ok(), await r.text()).toBeTruthy()
  }
  // A manager sends it out again by hand (the test can't wait for the next day).
  const sendAgain = async () => {
    const r = await request.patch(`${API}/admin/v1/orders/${orderId}/status`, {
      data: { status: 'OUT_FOR_DELIVERY', override: true, reason: 'Test run: out again' },
      ...staff,
    })
    expect(r.ok(), await r.text()).toBeTruthy()
  }

  await miss()
  await page.goto(`/orders/${orderId}`)
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(/^We missed you\. We'll try again on .+\.$/)).toBeVisible()

  // The third miss: nothing is booked, so no day is named.
  await sendAgain()
  await miss()
  await sendAgain()
  await miss()
  await page.reload()
  await expect(page.getByText("We missed you again. We'll call you to arrange a new delivery.")).toBeVisible()
  await expect(page.getByText(/try again on/)).toHaveCount(0)
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

  await page.getByRole('link', { name: 'Account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible()
  await expect(page.getByText(`+91 ${phone}`)).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click()
  await expect(page.getByText('Your account is deleted.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
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
  // Wait for the pincode to be saved before the helper reloads the page.
  await expect(page.getByRole('heading', { name: 'Pick your mangoes' })).toBeVisible()
  await addFromProductPage(page, 1, 0)
  await page.goto('/')
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
  if (await slots.count()) await slots.getByRole('radio', { disabled: false }).first().check()
  await page.getByLabel('Promo code (optional)').fill('NOSUCHCODE')
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('alert')).toContainText('Change or clear the promo code')
  await expect(page.getByLabel('Promo code (optional)')).toBeFocused()
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

test('the top bar changes the pincode and searches; the bottom tabs move between pages', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  await expect(page.getByRole('link', { name: 'Delivering to 560034, change' })).toBeVisible()

  // Search keeps only the matching mangoes, and says so when nothing matches.
  await page.getByRole('searchbox', { name: 'Search mangoes' }).fill('alphonso')
  await expect(page.getByRole('heading', { name: /Mangoes matching “alphonso”/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Alphonso/ }).first()).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Badami/ })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search mangoes' }).fill('papaya')
  await expect(page.getByText('No mangoes match “papaya”')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search mangoes' }).fill('')
  await expect(page.getByRole('heading', { name: 'Pick your mangoes' })).toBeVisible()

  // The address button opens the pincode form; "Keep" goes back without a change.
  await page.getByRole('link', { name: 'Delivering to 560034, change' }).click()
  await expect(page.getByLabel('Your delivery pincode')).toHaveValue('560034')
  await page.getByRole('button', { name: 'Keep 560034' }).click()
  await expect(page.getByRole('heading', { name: 'Pick your mangoes' })).toBeVisible()

  const tabs = page.getByRole('navigation', { name: 'Main' })
  await tabs.getByRole('link', { name: /Cart, 0 boxes/ }).click()
  await expect(page).toHaveURL(/\/cart$/)
  await tabs.getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('link', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in/)
  await noA11yViolations(page)
})

test('a focused item is never hidden behind the sticky cart bar or the tabs', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  await expect(page.getByRole('heading', { name: 'Pick your mangoes' })).toBeVisible()
  await addFromProductPage(page, 1, 0)
  await page.goto('/')
  await expect(page.getByRole('link', { name: /View cart/ })).toBeVisible()
  for (const name of ['How we pick and check', 'Privacy notice']) {
    const link = page.getByRole('contentinfo').getByRole('link', { name })
    await link.focus()
    const covered = await link.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !(hit && (hit === el || el.contains(hit)))
    })
    expect(covered, `${name} is covered`).toBe(false)
  }
})

test('home shows one tile per box; the ripeness is picked on the product page; variety story and quality page', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  const pick = page.getByRole('region', { name: 'Pick your mangoes' })
  await expect(pick.getByRole('listitem').first()).toBeVisible()
  await noA11yViolations(page)

  // Tiles carry no ripeness: that choice comes after the tap.
  await expect(pick.getByText(/^(Raw|Semi-ripe)$/)).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(0)
  const tile = pick.getByRole('listitem').filter({ hasNotText: 'Sold out' }).first()
  const name = (await tile.getByRole('heading', { level: 3 }).textContent())!
  await tile.click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
  await expect(page.getByRole('radio').first()).toBeVisible()

  await expect(page.getByRole('heading', { name: /^About / })).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('link', { name: 'How we pick and check every box' }).click()
  await expect(page.getByRole('heading', { name: 'How we pick and check every box' })).toBeVisible()
  await expect(page.getByText('refund')).toHaveCount(0)
  await noA11yViolations(page)
})

test('product page: Add to cart in the first screen, three reviews then See all, Show stock for another day', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await page.getByLabel('Your delivery pincode').fill('560034')
  await page.getByRole('button', { name: 'Show mangoes' }).click()
  const pick = page.getByRole('region', { name: 'Pick your mangoes' })
  await pick.getByRole('listitem').filter({ hasNotText: 'Sold out' }).first().getByRole('heading', { level: 3 }).getByRole('link').click()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()

  // UX-6: with Ripe sold out nothing is chosen for the customer; choose the first ripeness in stock.
  if (!(await page.getByRole('radio', { checked: true }).count())) await page.getByRole('radio', { disabled: false }).first().check()
  // The buy bar sits above the tabs without scrolling, and is not covered by them.
  const add = page.getByRole('button', { name: /^Add to cart · ₹/ })
  await expect(add).toBeInViewport({ ratio: 1 })
  const covered = await add.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !(hit && (hit === el || el.contains(hit)))
  })
  expect(covered, 'Add to cart is covered').toBe(false)
  await noA11yViolations(page)

  // Three reviews, then See all for the rest.
  const reviews = page.getByRole('region', { name: 'Reviews', exact: true }).getByRole('article')
  await expect(page.getByRole('heading', { name: 'Ratings and reviews' })).toBeVisible()
  expect(await reviews.count()).toBeLessThanOrEqual(3)
  const seeAll = page.getByRole('button', { name: /^See all \d+ reviews$/ })
  if (await seeAll.count()) {
    await seeAll.click()
    expect(await reviews.count()).toBeGreaterThan(3)
  }

  // A sold-out ripeness offers another day's stock; the switch is announced and can be undone.
  const other = page.getByRole('button', { name: /^Show stock for / })
  if (await other.count()) {
    const was = (await page.getByText(/^Showing stock for /).textContent())!.match(/for (.+)\. You/)![1]
    await other.first().click()
    const note = page.getByRole('status').filter({ hasText: /^Now showing stock for / })
    await expect(note).toBeFocused()
    await note.getByRole('button', { name: `Back to ${was}` }).click()
    await expect(page.getByText(`Showing stock for ${was}. You choose the delivery day at checkout.`)).toBeVisible()
  }
})

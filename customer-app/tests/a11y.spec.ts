import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../tests/fixtures'

// Accessibility across the whole shop, against the real API, at phone and desktop size (the two
// projects): axe on every page and every dialog, a keyboard walk from the skip link to Add to cart,
// and a browser title of its own for each page.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  // In CI the API is part of the job: a dead API is a failure, not a skip.
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

/** Runs axe (WCAG 2 A and AA) and fails with the rule and the elements, named by `where`. */
async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${where}: ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

/**
 * A customer with orders made through the API: one paid and confirmed (it can be moved or
 * cancelled), and with `delivered` one more that staff pack and deliver (it can be claimed and reviewed).
 */
async function customerWithOrders(request: APIRequestContext, phone: string, delivered: boolean) {
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  expect(asked.ok(), await asked.text()).toBeTruthy()
  const tokens = await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })).json()
  const login = await (await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })).json()
  const staff = as(login.accessToken)
  const order = async (n: number) => {
    const cat = await (await request.get(`${API}/v1/catalogue?pincode=560034`, as(tokens.accessToken))).json()
    const item = cat.items.find((i: { qty: number }) => i.qty > 0)
    expect(item, 'something in stock').toBeTruthy()
    await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, ...as(tokens.accessToken) })
    const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560034&delivery_date=${cat.deliveryDate}`, as(tokens.accessToken))).json()
    const slotId = slots.slots.find((s: { available: boolean }) => s.available)?.id ?? null
    const q = await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560034', deliveryDate: cat.deliveryDate, slotId }, ...as(tokens.accessToken) })
    expect(q.ok(), await q.text()).toBeTruthy()
    const confirm = await request.post(`${API}/v1/checkout/confirm`, {
      data: { quoteId: (await q.json()).quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', name: 'Asha Rao' },
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': `e2e-a11y-${phone}-${n}` },
    })
    expect(confirm.ok(), await confirm.text()).toBeTruthy()
    const { orderId } = await confirm.json()
    await request.post(`${API}/v1/dev/pay`, { data: { orderId, outcome: 'captured' } })
    return orderId as string
  }
  const confirmed = await order(1)
  if (!delivered) return { confirmed, delivered: null }
  const done = await order(2)
  for (const step of [
    () => request.patch(`${API}/admin/v1/orders/${done}/status`, { data: { status: 'PROCESSING' }, ...staff }),
    () => request.post(`${API}/admin/v1/orders/${done}/allocate`, staff),
    () => request.patch(`${API}/admin/v1/orders/${done}/status`, { data: { status: 'PACKED' }, ...staff }),
    () => request.post(`${API}/admin/v1/orders/${done}/dispatch`, staff),
    () => request.patch(`${API}/admin/v1/orders/${done}/status`, { data: { status: 'DELIVERED', override: true, reason: 'Test run: handed over in person' }, ...staff }),
  ]) {
    const r = await step()
    expect(r.ok(), await r.text()).toBeTruthy()
  }
  return { confirmed, delivered: done }
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

/** Opens the first box with stock and adds one; returns false when nothing is in stock. */
async function addABox(page: Page) {
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
    await add.click()
    return true
  }
  return false
}

test('axe finds nothing on any shop page or dialog', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const phone = `9${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 3 : 4}`
  const orders = await customerWithOrders(request, phone, true)

  // Signed out: the pincode form, home, the pincode sheet, a product, the guides, Book ahead, sign-in.
  await page.goto('/')
  await expect(page.getByLabel('Your delivery pincode')).toBeVisible()
  await axe(page, 'home without a pincode')
  await setPincode(page)
  await axe(page, 'home')
  await page.getByRole('link', { name: 'Delivering to 560034, change' }).click()
  await expect(page.getByRole('button', { name: 'Keep 560034' })).toBeVisible()
  await axe(page, 'pincode sheet')
  await page.getByRole('button', { name: 'Keep 560034' }).click()

  await page.getByRole('region', { name: 'Pick your mangoes' }).getByRole('heading', { level: 3 }).getByRole('link').first().click()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ratings and reviews' })).toBeVisible()
  await axe(page, 'product')
  const photo = page.getByRole('button', { name: /^Open photo 1 of/ }).first()
  if (await photo.count()) {
    await photo.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await axe(page, 'review photo dialog')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  for (const [path, heading] of [
    ['/quality', 'How we pick and check every box'],
    ['/privacy', 'Privacy notice'],
    ['/help', 'Help'],
    ['/terms', 'Terms of sale'],
    ['/preorder', 'Book ahead'],
    ['/cart', 'Your cart is empty'],
  ]) {
    await page.goto(path)
    // Book ahead shows "No weeks open" until a manager opens a week (another test does), so either heading is fine.
    const h1 = page.getByRole('heading', { level: 1, name: heading })
    await expect(path === '/preorder' ? h1.or(page.getByRole('heading', { level: 1, name: 'No weeks open for booking' })) : h1).toBeVisible()
    await axe(page, path)
  }
  await page.goto('/sign-in')
  await expect(page.getByLabel('Mobile number')).toBeVisible()
  await axe(page, 'sign-in')

  // Signed in: account, orders, an order with its two dialogs, the claim and review forms.
  await signIn(page, phone)
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible()
  await axe(page, 'account')
  await page.goto('/orders')
  await expect(page.getByRole('heading', { level: 1, name: 'My orders' })).toBeVisible()
  await axe(page, 'orders')

  await page.goto(`/orders/${orders.confirmed}`)
  await expect(page.getByRole('button', { name: 'Cancel order' })).toBeVisible()
  await axe(page, 'order')
  await page.getByRole('button', { name: 'Change delivery day' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'New delivery day' }).or(dialog.getByText('There are no other delivery days open right now.'))).toBeVisible()
  await axe(page, 'change day dialog')
  // The day chips are one radio group: one Tab stop, and the arrow keys move the choice.
  const days = dialog.getByRole('radiogroup', { name: 'New delivery day' }).getByRole('radio')
  if ((await days.count()) > 1) {
    await days.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(days.nth(1)).toBeFocused()
    await expect(days.nth(1)).toHaveAttribute('aria-checked', 'true')
    await expect(days.first()).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('Home')
    await expect(days.first()).toHaveAttribute('aria-checked', 'true')
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel order' }).click()
  await expect(dialog.getByRole('button', { name: 'Keep order' })).toBeFocused()
  await axe(page, 'cancel confirm dialog')
  await dialog.getByRole('button', { name: 'Keep order' }).click()
  await expect(dialog).toHaveCount(0)

  await page.goto(`/orders/${orders.delivered}/claim`)
  await expect(page.getByRole('heading', { name: 'Report a problem' })).toBeVisible()
  await axe(page, 'claim')
  await page.goto(`/orders/${orders.delivered}`)
  await page.getByRole('link', { name: /^Write a review/ }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Write a review' })).toBeVisible()
  await axe(page, 'review form')

  // The cart, then checkout's form and review step (not paid).
  expect(await addABox(page), 'a box in stock').toBe(true)
  await page.goto('/cart')
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
  await axe(page, 'cart')
  await page.getByRole('button', { name: 'Continue to delivery' }).click()
  await expect(page.getByRole('heading', { name: 'Delivery details' })).toBeVisible()
  await axe(page, 'checkout form')
  // The API orders made a saved address, which is picked, so the address box may be hidden.
  const address = page.getByLabel('Delivery address')
  if (await address.isVisible()) await address.fill('Flat 4B, Lake View Apartments, 5th Main, near the park')
  const slots = page.getByRole('group', { name: 'Delivery time' })
  if (await slots.count()) await slots.getByRole('radio', { disabled: false }).first().check()
  await page.getByRole('button', { name: 'Review order' }).click()
  await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible()
  await axe(page, 'checkout review')
})

test('keyboard: Skip to content is the first stop, and Tab reaches Add to cart with a visible ring', async ({ page }) => {
  await setPincode(page)
  await page.getByRole('region', { name: 'Pick your mangoes' }).getByRole('listitem').filter({ hasNotText: 'Sold out' }).first().getByRole('link').click()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
  // UX-6: with Ripe sold out nothing is chosen for the customer, so open the box (a fresh load) at a ripeness in stock.
  const inStock = await page.getByRole('radio', { disabled: false }).first().getAttribute('value')
  await page.goto(`${new URL(page.url()).pathname}?stage=${inStock}`)
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()

  // Tab 1 is the skip link, shown while focused; Enter moves focus to the page's content.
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main')).toBeFocused()

  // From the top of the page, Tab on until Add to cart. Every stop is on screen, not under a
  // sticky bar, and shows a focus ring (the search box and tiles draw it on their wrapper).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.evaluate(() => window.scrollTo(0, 0))
  let reached = false
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const ringed = [el, el.closest('.search, .tile')].some((x) => x && getComputedStyle(x).outlineStyle !== 'none')
      return { name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60), visible: Boolean(hit && (hit === el || el.contains(hit))), ringed }
    })
    if (!stop) continue
    expect(stop.visible, `${stop.name} is covered or off screen`).toBe(true)
    expect(stop.ringed, `${stop.name} has no focus ring`).toBe(true)
    reached = /^Add to cart/.test(stop.name)
  }
  expect(reached, 'Tab reaches Add to cart').toBe(true)
})

test('each page has a browser title of its own', async ({ page, request }, info) => {
  const phone = `9${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 5 : 6}`
  const orders = await customerWithOrders(request, phone, false)
  const titles = new Map<string, string>()
  const record = async (page_: string) => {
    // Pages that load their name (a box, an order number) set it once it arrives.
    await expect(page).not.toHaveTitle(/^(MandiMangoes|Mangoes · MandiMangoes|Your order · MandiMangoes)$/)
    titles.set(page_, await page.title())
  }

  await setPincode(page)
  await record('home')
  await page.getByRole('region', { name: 'Pick your mangoes' }).getByRole('heading', { level: 3 }).getByRole('link').first().click()
  await expect(page.getByRole('group', { name: 'Choose ripeness' })).toBeVisible()
  await record('product')
  for (const path of ['/cart', '/preorder', '/quality', '/privacy', '/sign-in', '/no-such-page']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await record(path)
  }
  await signIn(page, phone)
  for (const path of ['/account', '/orders', `/orders/${orders.confirmed}`, `/orders/${orders.confirmed}/claim`]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await record(path)
  }
  expect(await page.title()).toMatch(/^Report a problem · MandiMangoes$/)
  await page.goto(`/orders/${orders.confirmed}`)
  await expect(page).toHaveTitle(/^Order ORD-\d+ · MandiMangoes$/)

  const all = [...titles.entries()]
  for (const [where, title] of all) expect(title, where).toMatch(/^.+ · MandiMangoes$/)
  const seen = new Map<string, string>()
  for (const [where, title] of all) {
    expect(seen.get(title), `${where} has the same title as ${seen.get(title)}: ${title}`).toBeUndefined()
    seen.set(title, where)
  }
})

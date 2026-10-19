import { expect, test } from '../../tests/fixtures'

// Neighborhood Unlock in the shop, against the real API: a shared link opens
// the right pincode and day, the card shows the server's real count, and the
// count moves when a neighbour orders.

const API = process.env.VITE_API_URL ?? 'http://localhost:3000'
const SHOTS = process.env.UNLOCK_SHOTS

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

type Req = import('@playwright/test').APIRequestContext

async function staff(request: Req) {
  const r = await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })
  const token = (await r.json()).accessToken as string
  const h = { Authorization: `Bearer ${token}` }
  await request.put(`${API}/admin/v1/unlock/settings`, { data: { enabled: true }, headers: h })
  const zones = (await (await request.get(`${API}/admin/v1/zones`, { headers: h })).json()) as { id: string; label: string }[]
  let zone = zones.find((z) => z.label === 'Indiranagar')
  if (!zone) zone = await (await request.post(`${API}/admin/v1/zones`, { data: { label: 'Indiranagar', pincodes: ['560038', '560008'] }, headers: h })).json()
  const check = await (await request.get(`${API}/v1/delivery/check?pincode=560038`)).json()
  const date = check.deliveryDates.at(-1) as string
  const made = await request.post(`${API}/admin/v1/unlock/campaigns`, { data: { zoneId: zone!.id, deliveryDate: date, threshold: 5 }, headers: h })
  if (made.ok()) await request.post(`${API}/admin/v1/unlock/campaigns/${(await made.json()).id}/open`, { headers: h })
  return date
}

/** A neighbour orders and pays, through the API. */
async function neighbourOrders(request: Req, date: string, n: number) {
  const phone = `97${String(Date.now()).slice(-7)}${n}`
  const code = (await (await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })).json()).devCode
  const token = (await (await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code } })).json()).accessToken
  const h = { Authorization: `Bearer ${token}` }
  const cat = await (await request.get(`${API}/v1/catalogue?pincode=560038&delivery_date=${date}`)).json()
  const item = cat.items.find((i: { qty: number }) => i.qty > 0)
  await request.post(`${API}/v1/cart/items`, { data: { sku: item.sku, stage: item.stage, qty: 1 }, headers: h })
  const slots = await (await request.get(`${API}/v1/delivery/slots?pincode=560038&delivery_date=${date}`)).json()
  const q = await (await request.post(`${API}/v1/checkout/quote`, { data: { pincode: '560038', deliveryDate: date, slotId: slots.slots[0]?.id ?? null }, headers: h })).json()
  const c = await (await request.post(`${API}/v1/checkout/confirm`, { data: { quoteId: q.quoteId, address: `${n}, 12th Main, Indiranagar, Bengaluru` }, headers: { ...h, 'Idempotency-Key': `unlock-${phone}` } })).json()
  await request.post(`${API}/v1/dev/pay`, { data: { orderId: c.orderId, outcome: 'captured' } })
}

test('a shared link opens the area and day, and the card shows the real count', async ({ page, request }, info) => {
  const date = await staff(request)
  const tally = (c: { current: number; threshold: number }) => (c.current < c.threshold ? `${c.current} of ${c.threshold}` : `${c.current} (target ${c.threshold})`)
  const real = async () => (await (await request.get(`${API}/v1/unlock/progress?pincode=560038&date=${date}`)).json()).campaigns[0]

  await page.goto(`/?pin=560038&date=${date}`)
  await expect(page.getByText('Delivering to')).toContainText('560038')
  await expect(page).toHaveURL(/\/$/)
  const card = page.getByRole('region', { name: 'Neighbourhood reward for Indiranagar' })
  const before = await real()
  await expect(card).toContainText(tally(before))
  await expect(card).toContainText('Your delivery comes either way')
  await expect(page.getByRole('radio', { checked: true })).toHaveAttribute('aria-checked', 'true')

  const share = card.getByRole('link', { name: 'Share with neighbours on WhatsApp' })
  const href = decodeURIComponent((await share.getAttribute('href'))!)
  expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/)
  expect(href).toContain(`/?pin=560038&date=${date}`)

  await neighbourOrders(request, date, info.project.name === 'phone' ? 1 : 2)
  await page.reload()
  const after = await real()
  expect(after.current).toBe(before.current + 1)
  await expect(card).toContainText(tally(after))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shop-card-${info.project.name}.png`, fullPage: false })
})

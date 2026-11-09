import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../../tests/fixtures'
import { MANAGER_CONFIRM, managerToken } from './staff'

// Farm Experience (docs/farm-experience.md) against the real API, with FARM_EXPERIENCE on.
// A manager sets up a variety, its harvest, a room and the farm's details (through the admin
// API), then a customer finds the farm visit in Bulk Deals, books 300 kg in six steps and pays
// (test payment). In the staff panel a manager gives the group a room and approves the stay;
// the customer sees it confirmed, then cancels more than a week ahead for a full refund.
// The farm details written here are test text for the e2e database only.

const API = (process.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PANEL = process.env.PANEL_URL ?? `http://localhost:${process.env.PANEL_PORT ?? 5173}`

type Req = import('@playwright/test').APIRequestContext
type Page = import('@playwright/test').Page

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
  const f = ((await (await request.get(`${API}/v1/policy`)).json()) as { features?: { farmExperience?: boolean } }).features ?? {}
  test.skip(!f.farmExperience, 'FARM_EXPERIENCE is off on this API')
})

/** A day in India, n days from today, as YYYY-MM-DD. */
const istDay = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10)
const rupee = (paise: number) => `₹${new Intl.NumberFormat('en-IN').format(paise / 100)}`

async function setUpFarm(request: Req, token: string, name: string, visit: string) {
  const headers = { Authorization: `Bearer ${token}` }
  const ok = async (r: Promise<import('@playwright/test').APIResponse>, status = 200) => {
    const res = await r
    expect(res.status(), await res.text()).toBe(status)
    return res.json()
  }
  const v = (await ok(request.post(`${API}/admin/v1/farm/varieties`, { headers, data: { name, pricePerKg: 12_000, ...MANAGER_CONFIRM } }), 201)) as { id: string }
  await ok(request.put(`${API}/admin/v1/farm/days/${visit}`, { headers, data: { open: true, closedReason: null, maxBookings: null, note: null } }))
  await ok(request.put(`${API}/admin/v1/farm/harvest/${v.id}/${visit}`, { headers, data: { estimatedKg: 2000, bookableKg: 1000 } }))
  const room = (await ok(request.post(`${API}/admin/v1/farm/rooms`, { headers, data: { name: `${name} room`, sleeps: 4, beds: 2 } }), 201)) as { id: string }
  const settings = {
    farmName: 'E2E test orchard', location: 'E2E test address', contactPhone: '+919800000000', arrivalInstructions: 'E2E: call at the gate.',
    checkInTime: '10:00', checkOutTime: '11:00', stayNights: 1, sleepingArrangements: 'E2E rooms.', bathroomFacilities: 'E2E bathrooms.',
    meals: { breakfast: true, lunch: true, dinner: true, refreshments: false }, transportPolicy: 'E2E: transport is not included.', weatherPolicy: 'E2E: moved in heavy rain.',
    seasonStart: istDay(0), seasonEnd: istDay(150), cancelDays: 7, rescheduleDays: 3, leadDays: 2, maxDaysAhead: 160,
    faqs: [{ q: 'E2E question?', a: 'E2E answer.' }], bookingsOpen: true,
  }
  // Both projects write the settings; the second one retries on the version clash.
  for (let i = 0; ; i++) {
    const cur = (await ok(request.get(`${API}/admin/v1/farm/settings`, { headers }))) as { version: number }
    const r = await request.put(`${API}/admin/v1/farm/settings`, { headers, data: { settings, version: cur.version, ...MANAGER_CONFIRM } })
    if (r.status() === 409 && i < 3) continue
    expect(r.status(), await r.text()).toBe(200)
    break
  }
  return { varietyId: v.id, roomId: room.id }
}

async function noA11yViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

test('book a farm visit, pay, get the stay approved in the panel, then cancel for a refund', async ({ page, request, context }, info) => {
  test.slow()
  const token = await managerToken(request)
  // Each run books its own variety on its own day, so runs and projects don't share stock or rooms.
  const offset = 20 + (Date.now() % 40) + (info.project.name === 'desktop' ? 41 : 0)
  const visit = istDay(offset)
  const name = `E2E ${info.project.name} ${Date.now()}`
  testRoom = (await setUpFarm(request, token, name, visit)).roomId

  // Bulk Deals shows the farm visit; the landing page reads the farm's own details.
  await page.goto('/bulk')
  await expect(page.getByRole('heading', { name: 'Farm Experience' })).toBeVisible()
  await page.getByRole('link', { name: 'See the farm visit' }).click()
  await expect(page.getByRole('heading', { name: 'Farm Experience', level: 1 })).toBeVisible()
  await expect(page.getByText('E2E test orchard').first()).toBeVisible()
  await expect(page.getByText('E2E: transport is not included.').first()).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('link', { name: 'Book a visit' }).first().click()

  await page.getByLabel('Mobile number').fill(`9${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 5 : 6}`)
  await page.getByRole('button', { name: 'Send code' }).click()
  const hint = await page.getByText(/Test mode: your code is \d{6}/).textContent()
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: 'Sign in' }).click()

  // 1. Variety
  await expect(page.getByText('Step 1 of 6: Variety')).toBeVisible()
  await page.getByRole('radio', { name: new RegExp(name) }).check()
  await page.getByRole('button', { name: 'Continue' }).click()
  // 2. Kilograms: below 250 is refused, the price follows the kilograms.
  await page.getByLabel('Kilograms of mangoes').fill('200')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Enter 250 kg or more, in whole kilograms.')).toBeVisible()
  await page.getByLabel('Kilograms of mangoes').fill('300')
  await expect(page.getByText(`300 kg at ₹120 per kg: ${rupee(3_600_000)}`)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  // 3. Visit date: only days with 300 kg of this variety left are offered.
  const dates = page.getByRole('radiogroup', { name: 'Choose a visit date' })
  await expect(dates.getByRole('radio')).toHaveCount(1)
  await dates.getByRole('radio').first().click()
  await page.getByRole('button', { name: 'Continue' }).click()
  // 4. Group: no guest limit, two of them stay the night.
  await expect(page.getByText(/Groups larger than the farmhouse are welcome/)).toBeVisible()
  await page.getByLabel('Adults').fill('3')
  await page.getByLabel('Staying overnight').fill('2')
  await page.getByRole('button', { name: 'Continue' }).click()
  // 5. Details
  await page.getByLabel('Your name').fill('Asha E2E')
  await page.getByRole('button', { name: 'Continue' }).click()
  // 6. Summary: the policies must be accepted before paying.
  await expect(page.getByText('Step 6 of 6: Summary')).toBeVisible()
  await expect(page.getByText('3 adults, 0 children, 2 staying overnight')).toBeVisible()
  await noA11yViolations(page)
  await page.getByRole('button', { name: `Pay ${rupee(3_600_000)}` }).click()
  await expect(page.getByText('Please read and accept the booking policies.')).toBeVisible()
  await page.getByLabel(/I have read the booking policies/).check()
  await page.getByRole('button', { name: `Pay ${rupee(3_600_000)}` }).click()

  await expect(page.getByRole('heading', { name: /^Farm visit MMF-/ })).toBeVisible()
  const number = (await page.getByRole('heading', { name: /^Farm visit MMF-/ }).textContent())!.replace('Farm visit ', '').trim()
  await page.getByRole('button', { name: 'Payment succeeds' }).click()
  await expect(page.getByText('Paid: stay being arranged').first()).toBeVisible()
  await expect(page.getByText('Your check-in code')).toBeVisible()
  await expect(page.getByRole('img', { name: 'QR code for checking in at the farm' })).toBeVisible()
  await noA11yViolations(page)
  const bookingUrl = page.url()
  const bookingId = bookingUrl.split('/').pop()!

  // The staff panel: the booking is listed; a manager gives the group the room and approves the stay.
  const panel = await context.newPage()
  await panel.goto(`${PANEL}/login`)
  await panel.getByLabel('Work email').fill('manager@mandimangoes.test')
  await panel.getByLabel('Password').fill('manager123')
  await panel.getByRole('button', { name: 'Sign in' }).click()
  await expect(panel).not.toHaveURL(/\/login/)
  await panel.goto(`${PANEL}/farm/bookings?q=${encodeURIComponent(number)}`)
  await panel.getByRole('link', { name: number }).click()
  await expect(panel.getByRole('heading', { name: `Farm booking ${number}` })).toBeVisible()
  await noA11yViolations(panel)
  await panel.getByRole('button', { name: 'Assign rooms' }).click()
  const rooms = panel.getByRole('dialog', { name: 'Assign rooms' })
  await rooms.getByRole('checkbox', { name: new RegExp(`^${name} room`) }).check()
  await rooms.getByLabel('Guests').fill('2')
  await rooms.getByRole('button', { name: 'Save rooms' }).click()
  await expect(rooms).toBeHidden()
  await panel.getByRole('button', { name: 'Approve stay' }).click()
  const approve = panel.getByRole('dialog')
  if (await approve.count()) await approve.getByRole('button', { name: /Approve/ }).click()
  await expect(panel.getByText('Confirmed', { exact: true }).first()).toBeVisible()
  await panel.close()

  // The customer sees the stay confirmed with the room, then cancels more than 7 days ahead: a full refund.
  await page.reload()
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(`${name} room`)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel booking' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cancel this farm visit?' })
  await expect(dialog.getByText(`You get a full refund of ${rupee(3_600_000)} to the way you paid.`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel booking' }).click()
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()

  // The booking is cancelled on the server too.
  const after = (await (await request.get(`${API}/admin/v1/farm/bookings/${bookingId}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { status: string }
  expect(after.status).toBe('CANCELLED')
})

// The test room is taken out of the farmhouse again, pass or fail, so later runs see only their own.
let testRoom: string | null = null
test.afterEach(async ({ request }) => {
  if (!testRoom) return
  const token = await managerToken(request)
  await request.patch(`${API}/admin/v1/farm/rooms/${testRoom}`, { headers: { Authorization: `Bearer ${token}` }, data: { active: false } })
  testRoom = null
})

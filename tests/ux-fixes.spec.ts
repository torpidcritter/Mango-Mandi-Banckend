import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Staff side of the 23 Oct UX audit: a claim rejection needs a reason the customer sees
// (UX-4 / ADM-3), a price change is confirmed with the old and new price and an optional
// reason (ADM-2), managers can say what is in the box, and order search takes a name or an
// address (ADM-1).

async function scan(page: import('@playwright/test').Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${where}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test('rejecting a claim needs a reason for the customer, and the reason is sent', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  // c2 is under review (the mock's seed); only it offers Resolve.
  api.claims = api.claims.filter((c) => c.id === 'c2')
  await page.goto('/claims')
  await page.getByRole('button', { name: 'Resolve ORD-1043' }).click()
  const dialog = page.getByRole('dialog', { name: 'Resolve claim on ORD-1043' })
  await dialog.getByLabel('Reject').check()
  const reason = dialog.getByLabel('Reason for the customer')
  await expect(reason).toBeVisible()
  await expect(dialog.getByText('The customer sees this on their order page and on WhatsApp')).toBeVisible()
  const reject = dialog.getByRole('button', { name: 'Reject claim' })
  await expect(reject).toBeDisabled()
  await reason.fill('no')
  await expect(reject).toBeDisabled()
  await scan(page, 'reject dialog')
  await reason.fill('The delivery photo shows both boxes sealed and undamaged.')
  await reject.click()
  await expect(dialog).toHaveCount(0)
  const sent = api.calls.find((c) => c.method === 'POST' && c.path === '/claims/c2/resolve')
  expect(sent?.body).toEqual({ resolution: 'REJECTED', reason: 'The delivery photo shows both boxes sealed and undamaged.' })
})

test('approving a replacement asks for no reason', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  // c2 is under review (the mock's seed); only it offers Resolve.
  api.claims = api.claims.filter((c) => c.id === 'c2')
  await page.goto('/claims')
  await page.getByRole('button', { name: 'Resolve ORD-1043' }).click()
  const dialog = page.getByRole('dialog', { name: 'Resolve claim on ORD-1043' })
  await dialog.getByLabel(/^Replacement/).check()
  await expect(dialog.getByLabel('Reason for the customer')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Approve replacement' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.path === '/claims/c2/resolve')?.body).toEqual({ resolution: 'REPLACEMENT_APPROVED' })
})

test('a resolved claim shows the reason given', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.claims = [{ ...api.claims[0], status: 'RESOLVED', resolution: 'REJECTED', rejectionReason: 'Boxes were sealed on delivery.' }] as unknown as typeof api.claims
  await page.goto('/claims?status=RESOLVED')
  await expect(page.getByText('Reason given')).toBeVisible()
  await expect(page.getByText('Boxes were sealed on delivery.')).toBeVisible()
})

test('a price change shows the old and new price, takes a reason, and can go back', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/products')
  await page.getByRole('button', { name: 'Edit Alphonso 3kg Box' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit Alphonso 3kg Box' })
  await edit.getByLabel('Price in rupees').fill('1999')
  await edit.getByRole('button', { name: 'Save' }).click()
  const confirm = page.getByRole('dialog', { name: 'Change the price of Alphonso 3kg Box?' })
  await expect(confirm).toContainText('₹1,899.00 → ₹1,999.00')
  await expect(confirm).toContainText('Orders already placed keep their price')
  expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false)
  await scan(page, 'price change dialog')

  // Back returns to the form with the new price still typed in.
  await confirm.getByRole('button', { name: 'Back' }).click()
  await expect(edit.getByLabel('Price in rupees')).toHaveValue('1999')
  await edit.getByRole('button', { name: 'Save' }).click()
  await confirm.getByLabel('Reason (optional)').fill('Mandi rate went up')
  await confirm.getByRole('button', { name: 'Change price' }).click()
  await expect(confirm).toHaveCount(0)
  const patch = api.calls.find((c) => c.method === 'PATCH' && c.path === '/products/ALP-3')?.body
  expect(patch).toMatchObject({ price: 199900, reason: 'Mandi rate went up' })
})

test('managers fill in what is in the box; an unchanged price saves without asking', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/products')
  await page.getByRole('button', { name: 'Edit Alphonso 3kg Box' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit Alphonso 3kg Box' })
  await edit.getByLabel('Mangoes per box, about').fill('12')
  await edit.getByLabel('Weight of one mango, about, in grams').fill('20')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit.getByRole('alert')).toContainText('grams, from 50 to 3000')
  await edit.getByLabel('Weight of one mango, about, in grams').fill('250')
  await scan(page, 'product dialog')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toHaveCount(0)
  const patch = api.calls.find((c) => c.method === 'PATCH' && c.path === '/products/ALP-3')?.body
  expect(patch).toMatchObject({ fruitsPerBox: 12, fruitWeightG: 250, price: 189900 })
  expect(patch).not.toHaveProperty('reason')
})

test('order search says it takes a name or an address, and sends it', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/orders')
  await page.getByLabel('Search by order number, phone, name or address').fill('Koramangala')
  await page.getByLabel('Search by order number, phone, name or address').press('Enter')
  await expect(page).toHaveURL(/q=Koramangala/)
  await expect.poll(() => api.calls.some((c) => c.method === 'GET' && c.path === '/orders')).toBe(true)
})

import { expect, test, navLinkAnyState } from './fixtures'
import { mockApi } from './mock-api'

// Promo codes (manager only) and gift orders on the order page, pack list and rider run.

test('a manager makes a promo code and turns one off', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/promos')
  await expect(page.getByRole('heading', { name: 'Promo codes' })).toBeVisible()
  const row = page.getByRole('row', { name: /DIWALI10/ })
  await expect(row).toContainText('10% off, up to ₹300')
  await expect(row).toContainText('once per customer')

  await page.getByRole('button', { name: 'New promo code' }).click()
  const dialog = page.getByRole('dialog', { name: 'New promo code' })
  await dialog.getByLabel('Code').fill('ab')
  await dialog.getByRole('button', { name: 'Make code' }).click()
  await expect(dialog.getByRole('alert')).toContainText('3 to 20 letters')
  await dialog.getByLabel('Code').fill('sorry200')
  await dialog.getByLabel('An amount in rupees').check()
  await dialog.getByLabel('Rupees off').fill('200')
  await dialog.getByLabel("Only on a customer's first order").check()
  await dialog.getByRole('button', { name: 'Make code' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row', { name: /SORRY200/ })).toContainText('₹200.00 off')
  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/promos')
  expect(post?.body).toMatchObject({ code: 'SORRY200', kind: 'FLAT', value: 20000, firstOrderOnly: true })

  await page.getByRole('button', { name: 'Turn off DIWALI10' }).click()
  await expect(page.getByRole('row', { name: /DIWALI10/ })).toContainText('Off')
  expect(api.calls.some((c) => c.method === 'PATCH' && c.path === '/promos/DIWALI10')).toBe(true)
})

test('promo codes are a manager-only screen', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/today')
  await expect(navLinkAnyState(page, 'Promos')).toHaveCount(0)
  await page.goto('/promos')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
})

test('a gift order shows the recipient, the note and the discount', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.order = { ...api.order, discount: 12990, promoCode: 'DIWALI10', gift: { recipientName: 'Kavya Rao', recipientPhone: '9000000001', message: 'Happy Diwali!' } } as typeof api.order
  await page.goto('/orders/o1')
  await expect(page.getByRole('row', { name: /Promo DIWALI10/ })).toContainText('−₹129.90')
  await expect(page.getByText('Kavya Rao · 9000000001')).toBeVisible()
  await expect(page.getByText('Happy Diwali!')).toBeVisible()

  await page.goto('/pack-list?date=2026-10-16')
  const box = page.locator('.pack-order').first()
  await expect(box).toContainText('Gift')
  await expect(box).toContainText('Leave the price slip out')
  await expect(box).toContainText('Happy Diwali!')

  await page.goto('/deliveries?date=2026-10-16')
  await expect(page.getByRole('listitem', { name: 'ORD-1044' })).toContainText('Gift from Meera Iyer')
})

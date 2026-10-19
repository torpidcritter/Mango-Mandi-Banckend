import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Neighborhood Unlock: zones and campaigns, for managers and operators.

test('a manager makes a zone, a campaign, opens it, reads its details and shows it to customers', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/zones')
  await expect(page.getByRole('heading', { name: 'Zones' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Colaba/ })).toContainText('400001')
  await page.getByRole('button', { name: 'New zone' }).click()
  const zd = page.getByRole('dialog', { name: 'New zone' })
  await zd.getByLabel('Zone name').fill('Fort')
  await zd.getByLabel('Pincodes').fill('400005, 1234')
  await zd.getByRole('button', { name: 'Save zone' }).click()
  await expect(zd.getByRole('alert')).toContainText('Not a 6-digit pincode: 1234')
  await zd.getByLabel('Pincodes').fill('400005')
  await zd.getByRole('button', { name: 'Save zone' }).click()
  await expect(zd).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'POST' && c.path === '/zones')?.body).toEqual({ label: 'Fort', pincodes: ['400005'] })

  await page.goto('/campaigns')
  await expect(page.getByRole('heading', { name: 'Neighborhood Unlock' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'The feature is off' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Colaba/ })).toContainText('7 of 10')

  await page.getByRole('button', { name: 'New campaign' }).click()
  const cd = page.getByRole('dialog', { name: 'New campaign' })
  await cd.getByLabel('Area').selectOption({ label: 'Fort' })
  await cd.getByLabel('Delivery date').fill('2026-10-18')
  await cd.getByLabel('Customers needed').fill('8')
  await cd.getByLabel('Smallest order that counts, in rupees (optional)').fill('999')
  await cd.getByRole('button', { name: 'Save draft' }).click()
  await expect(cd).toHaveCount(0)
  expect(api.calls.find((c) => c.method === 'POST' && c.path === '/unlock/campaigns')?.body).toMatchObject({ zoneId: 'zon2', deliveryDate: '2026-10-18', threshold: 8, minOrderValue: 99900, orderBy: null })
  await page.getByRole('button', { name: 'Open Fort 2026-10-18' }).click()
  await expect.poll(() => api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/open'))).toBe(true)

  await page.getByRole('button', { name: 'Details Colaba 2026-10-17' }).click()
  const dd = page.getByRole('dialog', { name: /Colaba/ })
  await expect(dd).toContainText('7 of 10 customers')
  await expect(dd).toContainText('about 11 by the order-by time')
  await expect(dd.getByRole('list', { name: 'Suspicious clusters' })).toContainText('3 customers at one address')
  await dd.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Show to customers' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Customers can see open campaigns.' })).toBeVisible()
  await expect.poll(() => api.calls.find((c) => c.method === 'PUT' && c.path === '/unlock/settings')?.body).toEqual({ enabled: true })

  await page.getByRole('button', { name: 'New weekly repeat' }).click()
  const td = page.getByRole('dialog', { name: 'New weekly repeat' })
  await td.getByLabel('Colaba').check()
  await td.getByLabel('Delivery day').selectOption({ label: 'Saturday' })
  await td.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Every Saturday for Colaba: 10 customers')).toBeVisible()
})

test('operators run campaigns but cannot flip the switch; packers do not see the screens', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/campaigns')
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Unlock' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Show to customers/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Cancel Colaba 2026-10-17' })).toBeEnabled()
})

test('packers do not see the zones or campaign screens', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/pack-list')
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Zones' })).toHaveCount(0)
  await page.goto('/campaigns')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
})

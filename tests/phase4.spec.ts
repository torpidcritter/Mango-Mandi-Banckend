import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Phase 4: phone layouts. Batches and Orders are cards below 640px with status in view,
// and the status filter is a select there instead of a row of chips.

for (const [path, first, status] of [
  ['/batches', 'Alphonso', 'Selling'],
  ['/orders', 'ORD-1042', 'Processing'],
] as const) {
  test(`${path} at 375px: cards with status in view, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await mockApi(page, { signedIn: true })
    await page.goto(path)
    const row = page.getByRole('row', { name: new RegExp(first) })
    await expect(row.getByText(status, { exact: true })).toBeInViewport()
    const badge = (await row.getByText(status, { exact: true }).boundingBox())!
    expect(badge.x + badge.width).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    // The whole card opens the page.
    await expect(row.getByRole('link', { name: new RegExp(first) })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Filter by status' })).toBeHidden()
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: status })
    await expect(page).toHaveURL(/status=/)
  })

  test(`${path} at 1280px: a table with the status chips`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await mockApi(page, { signedIn: true })
    await page.goto(path)
    await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Filter by status' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Status' })).toBeHidden()
  })
}

test('a card opens its page when tapped anywhere on it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockApi(page, { signedIn: true })
  await page.goto('/batches')
  const row = page.getByRole('row', { name: /Alphonso/ })
  // A real tap on the "On hand" figure, away from the name: the row link's overlay takes it.
  const cell = row.locator('td[data-label="On hand"]')
  await cell.scrollIntoViewIfNeeded()
  const box = (await cell.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page).toHaveURL(/\/batches\/b1$/)
})

const PAGES = ['/today', '/batches', '/batches/b1', '/orders', '/orders/o1', '/pack-list', '/deliveries', '/claims', '/pincodes', '/planning', '/preorders', '/analytics', '/staff', '/reviews', '/products', '/promos', '/two-step']

test('no panel page scrolls sideways at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockApi(page, { signedIn: true })
  const wide: string[] = []
  for (const path of PAGES) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0)
    const w = await page.evaluate(() => document.documentElement.scrollWidth)
    if (w > 375) wide.push(`${path}: ${w}px`)
  }
  expect(wide).toEqual([])
})

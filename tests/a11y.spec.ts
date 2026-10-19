import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

const WCAG = ['wcag2a', 'wcag2aa']

async function scan(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test('login page has no WCAG A/AA violations', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  await expect(page.getByLabel('Work email')).toBeVisible()
  await scan(page)
})

test('login with session banner has no WCAG A/AA violations', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login?reason=expired')
  await expect(page.getByText('Your session has ended')).toBeVisible()
  await scan(page)
})

test('keyboard reaches email, password, then sign in', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  await expect(page.getByLabel('Work email')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Work email')).toBeFocused()
  await page.getByLabel('Work email').fill('a@b.c')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()
  await page.getByLabel('Password').fill('x')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused()
})

for (const path of ['/today', '/batches', '/batches/b1', '/orders', '/orders/o1', '/pack-list', '/deliveries', '/claims', '/pincodes', '/planning', '/preorders', '/analytics', '/staff', '/zones', '/campaigns']) {
  test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
    await mockApi(page, { signedIn: true })
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0)
    await scan(page)
  })
}

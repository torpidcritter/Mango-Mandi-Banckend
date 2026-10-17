import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Two-step sign-in: the code after the password, set-up when a role requires it, and a manager's reset.

async function noViolations(page: import('@playwright/test').Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
}

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Work email').fill('manager@mandimangoes.test')
  await page.getByLabel('Password').fill('correct')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('after the password, the code from the app; a recovery code works too', async ({ page }) => {
  const api = await mockApi(page, { twoStep: 'on' })
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible()
  await noViolations(page)
  const code = page.getByLabel('6-digit code')
  await code.fill('111111')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toContainText('That code is not right')

  await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click()
  await page.getByLabel('Recovery code').fill('abcd-efgh')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  expect(api.calls.filter((c) => c.path === '/auth/two-step').map((c) => (c.body as { code: string }).code)).toEqual(['111111', 'abcd-efgh'])
})

test('a manager who must use two-step sets it up before seeing the panel', async ({ page }) => {
  const api = await mockApi(page, { twoStep: 'required' })
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up two-step sign-in' }).click()
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  await expect(page.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeVisible()
  await noViolations(page)
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Turn on' }).click()

  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
  await expect(page.getByRole('link', { name: 'Download codes' })).toHaveAttribute('download', 'mandimangoes-recovery-codes.txt')
  await noViolations(page)
  await page.getByRole('button', { name: "I've saved them" }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  expect(api.twoStep.enabled).toBe(true)
})

test('anyone can turn it on from the menu; a manager resets someone who lost their phone', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/staff')
  const opsRow = page.getByRole('row', { name: /ops@mandimangoes\.test/ })
  await expect(opsRow.getByRole('cell', { name: 'On', exact: true })).toBeVisible()
  await opsRow.getByRole('button', { name: 'Reset two-step for ops@mandimangoes.test' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Reset' }).click()
  await expect.poll(() => api.calls.some((c) => c.path === '/staff/adm2/two-step/reset')).toBe(true)
  await expect(opsRow.getByRole('cell', { name: 'Off', exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Two-step sign-in (off)' }).click()
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up two-step sign-in' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Turn on' }).click()
  await page.getByRole('button', { name: "I've saved them" }).click()
  await expect(page.getByText(/^On\./)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Two-step sign-in', exact: true })).toBeVisible()
})

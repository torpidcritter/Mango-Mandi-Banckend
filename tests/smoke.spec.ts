import { expect, test, openAccount } from './fixtures'
import { mockApi } from './mock-api'

// Backend-free: every /admin/v1 call is served by tests/mock-api.ts.

test('unauthenticated root visit redirects to /login', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Mango Ops' })).toBeVisible()
})

test('login form renders with email and password', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  await expect(page.getByLabel('Work email')).toBeVisible()
  await expect(page.getByLabel('Password')).toBeVisible()
})

test('sign-in button stays disabled until both fields are filled', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  const button = page.getByRole('button', { name: 'Sign in' })
  await expect(button).toBeDisabled()
  await page.getByLabel('Work email').fill('ops@mandimangoes.test')
  await expect(button).toBeDisabled()
  await page.getByLabel('Password').fill('x')
  await expect(button).toBeEnabled()
})

test('wrong credentials show a generic error', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  await page.getByLabel('Work email').fill('ops@mandimangoes.test')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials')
})

test('a deep link goes to /login and back after signing in', async ({ page }) => {
  await mockApi(page)
  await page.goto('/pincodes')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Work email').fill('manager@mandimangoes.test')
  await page.getByLabel('Password').fill('correct')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/pincodes$/)
  await expect(page.getByRole('heading', { name: 'Pincodes' })).toBeVisible()
})

test('a returning user is restored from the refresh cookie', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'manager@mandimangoes.test · Manager' })).toBeVisible()
})

test('?reason=expired shows the session-ended banner', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login?reason=expired')
  await expect(page.getByText('Your session has ended')).toBeVisible()
})

test('no session banner on a normal visit', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login')
  await expect(page.getByLabel('Work email')).toBeVisible()
  await expect(page.getByText('Your session has ended')).toHaveCount(0)
})

test('signing out returns to the login screen', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/today')
  await (await openAccount(page)).getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('offline banner appears and clears', async ({ page, context }) => {
  await mockApi(page)
  await page.goto('/login')
  // Let the logo and icons finish loading, so going offline doesn't fail them.
  await page.waitForLoadState('networkidle')
  await context.setOffline(true)
  await expect(page.getByText('You are offline')).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText('You are offline')).toHaveCount(0)
})

test('unknown URLs show a not-found page', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/nope')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})

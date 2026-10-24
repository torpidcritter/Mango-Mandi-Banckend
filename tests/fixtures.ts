import { test as base, expect } from '@playwright/test'

// Every test fails if the page logs a console error or throws. The one
// exception is the browser's own "Failed to load resource" line for 4xx
// responses a test deliberately mocks (e.g. a 401 from /auth/refresh).
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const text = msg.text()
        if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return
        errors.push(text)
      })
      page.on('pageerror', (err) => errors.push(err.message))
      await use(errors)
      expect(errors, 'console errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

type Page = import('@playwright/test').Page

/** The main navigation. Its links are behind Menu on a phone and inside group dropdowns on a desktop. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })

/**
 * Opens whatever holds the nav link `name`: the Menu below 900px, or the link's group dropdown
 * on a desktop (a group with one link is a plain link and needs nothing). Returns the link.
 */
export async function openNavTo(page: Page, name: string) {
  const link = mainNav(page).getByRole('link', { name, exact: true })
  const menu = page.getByRole('button', { name: 'Menu' })
  // A page that is still loading can take focus as it appears (e.g. the QC form on a new batch),
  // which closes a menu opened a moment before. So open it again until the link shows.
  await expect(async () => {
    if (await link.isVisible()) return
    if (await menu.isVisible()) {
      if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click()
    } else {
      const group = mainNav(page)
        .locator('.nav-group')
        .filter({ has: page.getByRole('link', { name, exact: true, includeHidden: true }) })
      const button = group.locator('.nav-group-btn')
      if ((await button.count()) && (await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    }
    await expect(link).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  return link
}

/** A nav link whether or not its menu is open: use for checks that a role never gets a screen. */
export const navLinkAnyState = (page: Page, name: string) =>
  mainNav(page).getByRole('link', { name, exact: true, includeHidden: true })

/** The account button in the top bar (named "<email> · <role>"); opens its menu. */
export async function openAccount(page: Page) {
  const button = page.locator('.account-btn')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  return page.locator('#account-menu')
}

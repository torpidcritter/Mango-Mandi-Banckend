import AxeBuilder from '@axe-core/playwright'
import { expect, test, navLinkAnyState, openNavTo } from './fixtures'
import { mockApi } from './mock-api'

// Reviews: the moderation queue, the detail drawer (photos, reasons, the
// brand reply), bulk actions, insights, and who sees what.

const WCAG = ['wcag2a', 'wcag2aa']

test('an operator publishes a review with its photo, rejects a flagged one with a reason, and replies', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  await page.goto('/reviews')
  await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /Waiting/ })).toHaveAttribute('aria-pressed', 'true')
  const rows = page.getByRole('region', { name: 'Reviews', exact: true }).locator('tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('row', { name: /Two were bruised/ })).toContainText('Phone number')

  await page.getByRole('button', { name: 'Open review from Asha R.' }).click()
  const drawer = page.getByRole('dialog', { name: 'Review from Asha R.' })
  await expect(drawer).toContainText('Sweetest Alphonso')
  await expect(drawer.getByRole('img', { name: "Customer's photo 1" })).toBeVisible()
  await expect(drawer.getByRole('link', { name: /Alphonso picked/ })).toBeVisible()
  await drawer.getByLabel('Publish photo 1').check()
  await drawer.getByRole('button', { name: 'Publish with 1 photo' }).click()
  await expect(page.getByText('Review published')).toBeVisible()
  await expect.poll(() => api.calls.find((c) => c.path === '/reviews/rvw1/approve')?.body).toEqual({ photoIds: ['rph1'], reason: null })

  await drawer.getByRole('button', { name: 'Write a reply' }).click()
  await drawer.getByLabel(/Public reply/).fill('Thank you, Asha!')
  await drawer.getByRole('button', { name: 'Save reply' }).click()
  await expect(drawer).toContainText('Thank you, Asha!')
  await expect.poll(() => api.calls.find((c) => c.method === 'PUT' && c.path === '/reviews/rvw1/reply')?.body).toEqual({ body: 'Thank you, Asha!' })
  await drawer.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Open review from Vikram S.' }).click()
  const second = page.getByRole('dialog', { name: 'Review from Vikram S.' })
  await second.getByRole('button', { name: 'Reject', exact: true }).click()
  await second.getByRole('button', { name: 'Reject review' }).click()
  await expect(second.getByText('Give a short reason.')).toBeVisible()
  await second.getByLabel(/Reason for/).fill('Shares a phone number')
  await second.getByRole('button', { name: 'Reject review' }).click()
  await expect(page.getByText('Review rejected')).toBeVisible()
  await expect.poll(() => api.calls.find((c) => c.path === '/reviews/rvw2/reject')?.body).toEqual({ reason: 'Shares a phone number' })
})

test('bulk approve publishes the selected reviews; bulk reject asks for a reason', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/reviews')
  await page.getByLabel('Select all shown reviews').check()
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('2 selected')
  await page.getByRole('button', { name: 'Reject 2' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reject 2 reviews' })
  // The shared reason dialog: Reject waits for a reason, and says so in text.
  await expect(dialog.getByRole('button', { name: 'Reject' })).toBeDisabled()
  await expect(dialog.getByText('At least 3 characters.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Approve 2' }).click()
  await expect(page.getByText('2 reviews published')).toBeVisible()
  await expect.poll(() => api.calls.find((c) => c.path === '/reviews/bulk')?.body).toEqual({ action: 'approve', ids: ['rvw1', 'rvw2'], reason: null })
  await expect(page.getByText('No reviews here.')).toBeVisible()
  await page.getByRole('button', { name: /Published/ }).click()
  await expect(page.getByRole('region', { name: 'Reviews', exact: true }).locator('tbody tr')).toHaveCount(3)
})

test('insights show ripeness accuracy by variety and batch', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/reviews')
  const ins = page.getByRole('region', { name: 'What reviews say' })
  await expect(ins.getByRole('row', { name: /Alphonso 3 3.7 3.5/ })).toBeVisible()
  await expect(ins.getByRole('link', { name: /Alphonso, picked/ })).toBeVisible()
  await expect(ins.getByRole('region', { name: 'Low ratings by week' })).toContainText('33%')
})

test('QC sees ripeness insights only; packers and riders do not see Reviews', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'QC' })
  await page.goto('/reviews')
  await expect(page.getByRole('heading', { name: 'What reviews say' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Review status' })).toHaveCount(0)
  await expect(await openNavTo(page, 'Reviews')).toBeVisible()

  await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/pack-list')
  await expect(navLinkAnyState(page, 'Reviews')).toHaveCount(0)
  await page.goto('/reviews')
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible()
})

test('the review drawer has no WCAG A/AA violations and traps focus', async ({ page }) => {
  await mockApi(page, { signedIn: true })
  await page.goto('/reviews')
  await page.getByRole('button', { name: 'Open review from Asha R.' }).click()
  const drawer = page.getByRole('dialog', { name: 'Review from Asha R.' })
  await expect(drawer.getByRole('img', { name: "Customer's photo 1" })).toBeVisible()
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open review from Asha R.' })).toBeFocused()
})

test('a low rating shows on Needs attention', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.attention.lowRatings = [{ id: 'rvw2', rating: 2, comment: 'Two were bruised', sku: 'ALP-3', productName: 'Alphonso 3kg Box', createdAt: '2026-10-14T08:00:00Z', order: { id: 'o2', number: 'ORD-1044' } }]
  await page.goto('/today')
  const card = page.getByRole('region', { name: 'Needs attention' })
  await expect(card).toContainText('1 new review with 1 or 2 stars')
  await card.getByRole('link', { name: 'Read them' }).click()
  await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible()
})

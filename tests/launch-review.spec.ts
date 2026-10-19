import { expect, test } from './fixtures'
import type { Claim } from '../src/types'
import { mockApi } from './mock-api'

// Launch review: managers cancel bookings we can't fill with a refund, photo
// deliveries are checked by someone other than the rider, and claims show the
// customer's recent history.

test('a manager cancels a paid booking with a refund; operators cannot', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/preorders')
  await page.getByRole('button', { name: /^Cancel PRE-1001/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Reason').fill('Hail damaged the crop')
  await dialog.getByRole('button', { name: 'Cancel and refund' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/preorders/p1/cancel')?.body).toEqual({ reason: 'Hail damaged the crop' })
})

test('a photo delivery is signed off or flagged from Needs attention', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  api.attention = {
    ...api.attention,
    photoDeliveries: [
      { id: 'dat1', receivedBy: 'Security guard', photoId: 'dph1', actor: 'rider@mandimangoes.test', at: '2026-10-15T05:00:00Z', order: { id: 'o2', number: 'ORD-1043', name: 'Vikram' }, flags: ['5 wrong codes first'] },
      { id: 'dat2', receivedBy: 'Neighbour', photoId: 'dph2', actor: 'rider@mandimangoes.test', at: '2026-10-15T05:10:00Z', order: { id: 'o1', number: 'ORD-1042', name: 'Asha' }, flags: [] },
    ],
  }
  await page.goto('/')
  const card = page.locator('section.attention')
  await expect(card).toContainText('Check a photo delivery of ORD-1043')
  await expect(card).toContainText('5 wrong codes first')
  await card.getByRole('button', { name: 'Doubtful for ORD-1043' }).click()
  const dialog = page.getByRole('dialog', { name: 'What looks wrong with ORD-1043?' })
  await expect(dialog.getByRole('button', { name: 'Flag for a call' })).toBeDisabled()
  await dialog.getByLabel('Note for the order history').fill('Photo shows a different gate')
  await dialog.getByRole('button', { name: 'Flag for a call' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/delivery-reviews/dat1')?.body).toEqual({ ok: false, note: 'Photo shows a different gate' })
  await card.getByRole('button', { name: 'Looks right for ORD-1042' }).click()
  await expect.poll(() => api.calls.find((c) => c.path === '/delivery-reviews/dat2')?.body).toEqual({ ok: true })
})

test('claims show recent claims, how the order was delivered, and when a manager must approve', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  ;(api.claims as Claim[])[0] = {
    ...(api.claims[0] as Claim),
    issueType: 'NOT_DELIVERED',
    history: { claims90d: 2, replacements90d: 2 },
    delivery: { method: 'code', at: '2026-10-14T06:30:00Z' },
    managerNeeded: ['2 replacements in the last 90 days', "the customer's own code confirmed the delivery"],
  }
  await page.goto('/claims')
  const card = page.locator('article', { hasText: 'Two mangoes were crushed.' })
  await expect(card).toContainText('A manager has to approve a replacement: 2 replacements in the last 90 days')
  await expect(card).toContainText('2 other claims, 2 replaced')
  await expect(card).toContainText("with the customer's code")
})

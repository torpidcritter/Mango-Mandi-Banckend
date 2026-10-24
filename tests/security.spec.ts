import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Security fixes in the panel (23 Oct audit): giving stops to riders (SEC-02)
// and staff changing their own password (SEC-09).

test('a manager gives a stop, or a whole slot, to a rider on the Deliveries page', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/deliveries?date=2026-10-16')
  const stop = page.getByRole('list', { name: 'Morning · 07:00–11:00, 400001' })
  await stop.getByLabel('Rider for ORD-1042').selectOption({ label: 'rider@mandimangoes.test' })
  await expect(page.getByText('1 stop given to the rider')).toBeVisible()
  await expect.poll(() => api.calls.find((c) => c.path === '/manifest/assign')?.body).toEqual({ date: '2026-10-16', riderId: 'adm9', orderIds: ['o1'] })
  await expect(stop.getByLabel('Rider for ORD-1042')).toHaveValue('adm9')

  await page.getByLabel('Give Morning · 07:00–11:00 to').selectOption({ label: 'rider@mandimangoes.test' })
  await expect.poll(() => api.calls.filter((c) => c.path === '/manifest/assign').at(-1)?.body).toEqual({ date: '2026-10-16', riderId: 'adm9', slotId: 'slt1' })
})

test('a rider is told about stops nobody has yet, and takes them', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'RIDER' })
  ;(api.manifest as { unassigned?: number }).unassigned = 2
  await page.goto('/deliveries?date=2026-10-16')
  // Riders get no assign control.
  await expect(page.getByLabel('Rider for ORD-1042')).toHaveCount(0)
  const note = page.getByRole('status', { name: 'Stops nobody has yet' })
  await expect(note).toContainText('2 packed stops are not given to a rider yet')
  await note.getByRole('button', { name: 'Take them and start' }).click()
  await expect(page.getByText('1 order out for delivery')).toBeVisible()
  expect(api.calls.find((c) => c.path === '/manifest/dispatch')?.body).toEqual({ date: '2026-10-16' })
})

test('staff change their own password', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/two-step')
  const form = page.getByRole('region', { name: 'Your password' })
  await form.getByLabel('Current password').fill('wrong')
  await form.getByLabel('New password').fill('short')
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(form.getByRole('alert')).toHaveText('Use a new password of at least 12 characters.')
  await form.getByLabel('New password').fill('three ripe mangoes')
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(form).toContainText('Your current password is not right.')
  await form.getByLabel('Current password').fill('correct')
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed. You are signed out on your other devices.')).toBeVisible()
  expect(api.calls.filter((c) => c.path === '/me/password').at(-1)?.body).toEqual({ currentPassword: 'correct', newPassword: 'three ripe mangoes' })
})

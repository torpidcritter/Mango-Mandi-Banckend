import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// Box labels: printing, scan-to-pack, loading the van and the rider's door check.
// Phones without a camera API still work by typing the code printed under the QR.

test('labels are hidden while the feature is off', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'PACKER' })
  await page.goto('/pack-list?date=2026-10-16')
  await expect(page.getByRole('heading', { name: 'Pack list' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print box labels' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Scan' })).toHaveCount(0)
})

test('a packer prints labels and packs an order by typing box codes (no camera)', async ({ page }) => {
  // A browser with no camera access at all: the typed code is the only way in.
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }))
  const api = await mockApi(page, { signedIn: true, role: 'PACKER', labels: true })
  await page.goto('/pack-list?date=2026-10-16')

  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Print box labels' }).click()
  const labels = await popup
  await expect(labels.locator('body')).toContainText('ORD-1042 Box 1 of 2')
  await labels.close()
  expect(api.calls.find((c) => c.path === '/labels/print')?.body).toEqual({ date: '2026-10-16' })

  await page.getByRole('link', { name: 'Scan to pack ORD-1042' }).click()
  await expect(page.getByRole('heading', { name: 'Packing ORD-1042' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use camera' })).toHaveCount(0)
  const input = page.getByLabel('Scan each box, or type its code')
  const status = page.getByRole('status')

  await input.fill('ORD-1043-1')
  await input.press('Enter')
  await expect(status).toContainText('Wrong box: this is box 1 of ORD-1043')

  await input.fill('ord-1042-1')
  await input.press('Enter')
  await expect(status).toContainText('Box 1 scanned. 1 of 2 done.')
  await input.fill('ORD-1042-1')
  await input.press('Enter')
  await expect(status).toContainText('Box 1 was already scanned. 1 of 2 done.')

  await input.fill('ORD-1042-2')
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(status).toContainText('Box 2 scanned. ORD-1042 is packed.')
  await expect(page.getByText('2 of 2 boxes')).toBeVisible()
  expect(api.calls.filter((c) => c.path === '/scan/pack').map((c) => c.body)).toEqual([
    { orderId: 'o1', scan: 'ORD-1043-1' },
    { orderId: 'o1', scan: 'ord-1042-1' },
    { orderId: 'o1', scan: 'ORD-1042-1' },
    { orderId: 'o1', scan: 'ORD-1042-2' },
  ])
})

test('loading the van shows missing boxes and sends out only loaded orders', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, role: 'OPERATOR', labels: true })
  await page.goto('/deliveries?date=2026-10-16')
  await page.getByRole('link', { name: 'Load the van' }).click()
  await expect(page.getByRole('row', { name: /ORD-1042/ })).toContainText('Missing box 1, 2')
  const send = page.getByRole('button', { name: /Send out loaded orders/ })
  await expect(send).toBeDisabled()

  const input = page.getByLabel('Scan each box as it goes on the van')
  // A handheld scanner types the whole QR link.
  await input.fill('https://mandimangoes.in/b/token-1')
  await input.press('Enter')
  await expect(page.getByRole('status')).toContainText('ORD-1042 box 1 on the van. 1 of 2 for this order.')
  await input.fill('ORD-1042-2')
  await input.press('Enter')
  await expect(page.getByRole('row', { name: /ORD-1042/ })).toContainText('All boxes on the van')
  await send.click()
  await expect(page.getByText('1 order out for delivery')).toBeVisible()
  expect(api.calls.find((c) => c.path === '/scan/dispatch/send')?.body).toEqual({ date: '2026-10-16' })
})

test('riders get the van and door checks, and nothing else', async ({ page }) => {
  await mockApi(page, { signedIn: true, role: 'RIDER', labels: true })
  await page.goto('/scan?mode=door&order=o1')
  await expect(page.getByRole('group', { name: 'What are you scanning for?' }).getByRole('button')).toHaveText(['Load the van', 'At the door'])
  const input = page.getByLabel('Scan the box at the door')
  await input.fill('ORD-1043-1')
  await input.press('Enter')
  await expect(page.getByRole('status')).toContainText("Wrong box: this is for ORD-1043, not ORD-1042. Don't hand it over.")
  await input.fill('ORD-1042-1')
  await input.press('Enter')
  await expect(page.getByRole('status')).toContainText('Right box: ORD-1042 box 1. 1 of 2 checked.')
  await page.goto('/scan?mode=pack')
  await expect(page.getByRole('group', { name: 'What are you scanning for?' }).getByRole('button', { name: 'Pack' })).toHaveCount(0)
})

test('the order page lists its boxes and a reprint needs a reason', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true, labels: true })
  await page.goto('/orders/o1')
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Box labels' }) })
  await expect(card).toContainText('Box 1')
  await expect(card).toContainText('ORD-1042-2')
  await card.getByRole('button', { name: 'Reprint box 2' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reprint box 2 of ORD-1042' })
  await dialog.getByRole('button', { name: 'Reprint' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Say why')
  await dialog.getByLabel('Why reprint?').fill('Label got wet')
  const popup = page.waitForEvent('popup')
  await dialog.getByRole('button', { name: 'Reprint' }).click()
  await (await popup).close()
  await expect(dialog).toHaveCount(0)
  expect(api.calls.find((c) => c.path === '/labels/lbl2/reprint')?.body).toEqual({ reason: 'Label got wet' })
  await expect(card).toContainText('reprinted 1×')
})

test('a manager turns labels on and sets the label size on the selling rules', async ({ page }) => {
  const api = await mockApi(page, { signedIn: true })
  await page.goto('/planning')
  await page.getByRole('button', { name: 'Edit rules' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit selling rules' })
  await dialog.getByLabel(/Print box labels and scan boxes/).check()
  await dialog.getByLabel('Label height (mm)').fill('100')
  await dialog.getByLabel('Extra line at the bottom of each label (optional)').fill('Grown in Ratnagiri')
  await dialog.getByRole('button', { name: 'Save as new version' }).click()
  await expect(dialog).toHaveCount(0)
  const put = api.calls.find((c) => c.method === 'PUT' && c.path === '/config')?.body as { rules: { labels: unknown } }
  expect(put.rules.labels).toEqual({ enabled: true, widthMm: 50, heightMm: 100, footer: 'Grown in Ratnagiri', requireDispatchScan: false })
  await expect(page.getByText('Box labels and scanning: on')).toBeVisible()
})

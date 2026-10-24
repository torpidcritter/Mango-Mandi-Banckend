import { expect, test } from './fixtures'
import { mockApi } from './mock-api'

// The 23 Oct inventory audit fixes as staff see them: overdue orders (INV-G),
// the stock count (INV-D) and boxes back from a cancelled order (INV-F).

const overdue = {
  id: 'o1', number: 'ORD-1042', status: 'PACKED' as const, deliveryDate: '2026-10-13', daysLate: 2, outSince: null,
  reason: '2 days past its delivery date and still packed',
}

test('overdue orders show on Today and in Needs attention', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  Object.assign(state.summary, { overdueOrders: [overdue] })
  state.attention = {
    ...state.attention,
    overdueOrders: [overdue],
    retryDecisions: [{ id: 'o3', number: 'ORD-1044', deliveryDate: '2026-10-17', reason: 'packed ALP-3 from batch b1 is past the 7-day limit on 2026-10-17' }],
    returnedStock: [{ id: 'o2', number: 'ORD-1043', status: 'CANCELLED', boxes: 2 }],
    preorderDecisions: [{ id: 'p1', number: 'PRE-1001', customerName: 'Asha Rao', sku: 'ALP-3', qty: 2, weekStart: '2027-03-01', movedCount: 4, reason: 'moved forward 4 times without stock' }],
  }
  await page.goto('/')
  const table = page.getByRole('region', { name: 'Overdue orders' })
  await expect(table.getByRole('row', { name: /ORD-1042/ })).toContainText('2 days past its delivery date')
  const attention = page.getByRole('region', { name: 'Needs attention' })
  await expect(attention.getByText('Overdue deliveries')).toBeVisible()
  await expect(attention.getByText('Missed deliveries for a manager')).toBeVisible()
  await expect(attention.getByText('Returned boxes to book')).toBeVisible()
  await expect(attention.getByText('Preorders for a manager')).toBeVisible()
  await expect(attention.getByText(/moved forward 4 times/)).toBeVisible()
})

test('a stock count shows the difference and posts it with reason Count', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  state.batch = {
    ...state.batch,
    lines: [
      { id: 'l1', sku: 'ALP-3', onHand: 20, held: 2, committed: 3, reserveBuffer: 1, available: 14, packedNotDispatched: 2 } as (typeof state.batch.lines)[number],
      { id: 'l2', sku: 'ALP-5', onHand: 10, held: 0, committed: 6, reserveBuffer: 1, available: 3 },
    ],
  }
  await page.goto('/batches/b1')
  await page.getByRole('button', { name: 'Count stock' }).click()
  const dialog = page.getByRole('dialog', { name: 'Count stock' })
  // ALP-3: the books say 22 (20 on hand + 2 packed); 21 counted.
  await dialog.getByLabel('Boxes counted for ALP-3').fill('21')
  await expect(dialog.getByRole('row', { name: /ALP-3/ })).toContainText('-1')
  // ALP-5: 4 counted is below the 6 customers hold, so it goes in as a short arrival.
  await dialog.getByLabel('Boxes counted for ALP-5').fill('4')
  await dialog.getByRole('button', { name: 'Record 2 differences' }).click()
  await expect(dialog).toBeHidden()
  const patch = state.calls.find((c) => c.method === 'PATCH' && c.path === '/batches/b1/lines/l1')
  expect(patch?.body).toMatchObject({ onHand: 19, reasonCode: 'COUNT' })
  const short = state.calls.find((c) => c.path === '/batches/b1/lines/l2/short-arrival')
  expect(short?.body).toMatchObject({ onHand: 4, reasonCode: 'COUNT' })
})

test('an adjustment carries the reason picked', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  await page.goto('/batches/b1')
  await page.getByRole('button', { name: 'Adjust ALP-3' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('On hand').fill('18')
  await dialog.getByLabel('Why').selectOption({ label: 'Damaged' })
  await dialog.getByLabel('Reason').fill('2 crushed in unloading')
  await dialog.getByRole('button', { name: 'Save adjustment' }).click()
  await expect(dialog).toBeHidden()
  expect(state.calls.find((c) => c.method === 'PATCH' && c.path === '/batches/b1/lines/l1')?.body).toMatchObject({ onHand: 18, reasonCode: 'DAMAGED' })
})

test('boxes from an order cancelled on the road are written off with a reason', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  state.order = { ...state.order, status: 'CANCELLED', returnedBoxes: 2 } as typeof state.order
  await page.goto('/orders/o1')
  await expect(page.getByText(/2 boxes left the store with this order/)).toBeVisible()
  await page.getByRole('button', { name: 'Write off' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Why').selectOption({ label: 'Theft or loss' })
  await dialog.getByLabel('Note for the stock ledger').fill('rider lost them')
  await dialog.getByRole('button', { name: 'Write off' }).click()
  await expect(dialog).toBeHidden()
  expect(state.calls.find((c) => c.path === '/orders/o1/returned-stock')?.body).toEqual({ action: 'WRITE_OFF', reasonCode: 'THEFT_LOSS', reason: 'rider lost them' })
})

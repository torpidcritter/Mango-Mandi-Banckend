import { expect, test } from './fixtures'
import { mockApi, type MockState } from './mock-api'

// Recovery paths for what Needs attention raises: each item a manager can act
// on has a button, a reason, and leaves the list once done. Operators see the
// items but not the buttons (the API refuses them too).

function withProblems(state: MockState) {
  state.attention = {
    ...state.attention,
    loop: { lastRunAt: '2026-10-15T04:00:00Z', stale: true, failingSteps: ['refund-checks', 'stock-alerts', 'reminders', 'retention', 'rebalance', 'health'].map((step) => ({ step, since: '2026-10-15T04:00:00Z', error: null })) },
    backup: { lastOkAt: '2026-10-13T20:00:00Z', stale: true },
    ledgerDrift: [{ lineId: 'l1', batchId: 'b1', sku: 'ALP-3', onHand: [23, 20], reserveBuffer: [1, 1], held: [2, 2], committed: [3, 3] }],
    webhookFailures: [
      { id: 'whf1', source: 'razorpay', reason: "payment.captured for an order we don't have (order_x, payment pay_STRAY)", eventKey: 'evt_1', createdAt: '2026-10-15T04:10:00Z', paymentId: 'pay_STRAY', refundable: true },
      { id: 'whf2', source: 'razorpay', reason: "payment.failed for an order we don't have (order_y)", eventKey: 'evt_2', createdAt: '2026-10-15T04:12:00Z', paymentId: null, refundable: false },
    ],
    preorderDecisions: [{ id: 'p1', number: 'PRE-1001', customerName: 'Asha Rao', sku: 'ALP-3', qty: 2, weekStart: '2027-03-01', movedCount: 4, reason: 'moved forward 4 times without stock' }],
    stuckRefunds: [
      { type: 'order', id: 'o2', number: 'ORD-1043', requestedAt: '2026-10-15T03:00:00Z', paymentId: null, state: 'unsent' },
      { type: 'order', id: 'o1', number: 'ORD-1042 (second payment)', requestedAt: '2026-10-15T03:00:00Z', paymentId: 'pay_SECOND', state: 'unsent' },
      { type: 'order', id: 'o3', number: 'ORD-1044 (sent, not confirmed by Razorpay)', requestedAt: '2026-10-10T03:00:00Z', paymentId: null, state: 'unconfirmed' },
    ],
  }
}

const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Needs attention' })
const showAll = async (page: import('@playwright/test').Page, group: string) => {
  const g = card(page).locator('.attention-group', { hasText: group })
  await g.getByRole('button', { name: /Show all/ }).click()
  return g
}

test('the wording fits Vercel and Docker, and every maintenance step has a label', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  withProblems(state)
  await page.goto('/')
  const jobs = await showAll(page, 'Background jobs')
  await expect(jobs).toContainText('On Vercel, check the every-minute scheduler')
  await expect(jobs).toContainText('on the Docker server, restart the API')
  await expect(jobs).toContainText('Backup workflow in GitHub Actions')
  await expect(jobs).not.toContainText('deploy/README.md')
  for (const label of ['Checking refunds with Razorpay', 'Sending back-in-stock alerts', 'Sending reorder reminders', 'Removing old personal data', 'Re-checking an order', 'Health check']) {
    await expect(jobs).toContainText(`${label} is failing`)
  }
  for (const raw of ['refund-checks is', 'stock-alerts is', 'health is']) await expect(jobs).not.toContainText(raw)
})

test('ledger drift: a manager previews the repair, gives a reason and applies exactly the preview', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  withProblems(state)
  await page.goto('/')
  await card(page).getByRole('button', { name: 'Repair from the ledger for ALP-3' }).click()
  const dialog = page.getByRole('dialog', { name: 'Repair stock counts for ALP-3' })
  await expect(dialog.getByRole('row', { name: /On hand/ })).toContainText('2320')
  await expect(dialog.getByRole('button', { name: 'Repair counts' })).toBeDisabled()
  await dialog.getByLabel('Why the counts drifted').fill('hand edit in SQL on the 14th')
  await dialog.getByRole('button', { name: 'Repair counts' }).click()
  await expect
    .poll(() => state.calls.find((c) => c.method === 'POST' && c.path === '/batches/b1/lines/l1/repair')?.body)
    .toEqual({ reason: 'hand edit in SQL on the 14th', expected: { onHand: 20, reserveBuffer: 1, held: 2, committed: 3 } })
  await expect(card(page).getByText('Stock counts disagree with the ledger')).toHaveCount(0)
})

test('webhook problems: Mark resolved with a note, and Refund this payment only where it is refundable', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  withProblems(state)
  await page.goto('/')
  const hooks = card(page).locator('.attention-group', { hasText: 'Webhook problems' })
  await expect(hooks.getByRole('button', { name: /Refund this payment/ })).toHaveCount(1)
  await hooks.getByRole('button', { name: 'Refund this payment pay_STRAY' }).click()
  const refund = page.getByRole('dialog', { name: 'Refund payment pay_STRAY?' })
  await refund.getByLabel('Why it bought nothing').fill('checked Razorpay: no order')
  await refund.getByRole('button', { name: 'Refund in full' }).click()
  await expect.poll(() => state.calls.find((c) => c.path === '/webhook-failures/whf1/refund')?.body).toEqual({ reason: 'checked Razorpay: no order' })

  await expect(hooks.getByRole('button', { name: /Mark resolved/ })).toHaveCount(1) // the refunded one left the list
  await hooks.getByRole('button', { name: /Mark resolved/ }).click()
  const resolve = page.getByRole('dialog', { name: 'Mark this webhook problem resolved' })
  await resolve.getByLabel('What you checked or fixed').fill('test site, webhook URL fixed')
  await resolve.getByRole('button', { name: 'Mark resolved' }).click()
  await expect.poll(() => state.calls.find((c) => c.path === '/webhook-failures/whf2/resolve')?.body).toEqual({ note: 'test site, webhook URL fixed' })
  await expect(card(page).getByText('Webhook problems')).toHaveCount(0)
})

test('preorder needing a decision: Keep booking with a reason', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  withProblems(state)
  await page.goto('/')
  await card(page).getByRole('button', { name: 'Keep booking PRE-1001' }).click()
  const dialog = page.getByRole('dialog', { name: 'Keep preorder PRE-1001?' })
  await dialog.getByLabel('Why keep it').fill('customer happy to wait')
  await dialog.getByRole('button', { name: 'Keep booking' }).click()
  await expect.poll(() => state.calls.find((c) => c.path === '/preorders/p1/keep')?.body).toEqual({ reason: 'customer happy to wait' })
  await expect(card(page).getByText('Preorders for a manager')).toHaveCount(0)
})

test('a refund that can never go through: Paid back another way needs a reference; a second payment goes by its payment id', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  withProblems(state)
  await page.goto('/')
  const refunds = card(page).locator('.attention-group', { hasText: 'Refunds not sent' })
  await expect(refunds.getByRole('button', { name: /Paid back another way/ })).toHaveCount(2) // not on the one already sent
  await refunds.getByRole('button', { name: 'Paid back another way for ORD-1043' }).click()
  let dialog = page.getByRole('dialog', { name: 'Paid back another way: ORD-1043' })
  await dialog.getByLabel("Why Razorpay can't refund it").fill('card account closed')
  await dialog.getByRole('button', { name: 'Record as paid back' }).click()
  await expect(dialog).toContainText('Give the reference of the payment you made')
  await dialog.getByLabel('Reference of your payment').fill('NEFT UTR 123456')
  await dialog.getByRole('button', { name: 'Record as paid back' }).click()
  await expect
    .poll(() => state.calls.filter((c) => c.path === '/refunds/o2/paid-another-way').at(-1)?.body)
    .toEqual({ type: 'order', reference: 'NEFT UTR 123456', reason: 'card account closed' })

  await refunds.getByRole('button', { name: 'Paid back another way for ORD-1042 (second payment)' }).click()
  dialog = page.getByRole('dialog', { name: /Paid back another way: ORD-1042/ })
  await dialog.getByLabel('Reference of your payment').fill('UPI 998877')
  await dialog.getByLabel("Why Razorpay can't refund it").fill('paid back by UPI')
  await dialog.getByRole('button', { name: 'Record as paid back' }).click()
  await expect
    .poll(() => state.calls.find((c) => c.path === '/refunds/pay_SECOND/paid-another-way')?.body)
    .toEqual({ type: 'payment', reference: 'UPI 998877', reason: 'paid back by UPI' })
})

test('operators see the items but none of the manager buttons', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true, role: 'OPERATOR' })
  withProblems(state)
  await page.goto('/')
  await expect(card(page).getByText('Stock counts disagree with the ledger')).toBeVisible()
  for (const name of [/Repair from the ledger/, /Mark resolved/, /Refund this payment/, /Keep booking/, /Paid back another way/]) {
    await expect(card(page).getByRole('button', { name })).toHaveCount(0)
  }
})

test('Staff: a manager signs out all staff with a reason, keeping their own session', async ({ page }) => {
  const state = await mockApi(page, { signedIn: true })
  await page.goto('/staff')
  await page.getByRole('button', { name: 'Sign out all staff' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out all staff?' })
  await expect(dialog.getByLabel('Keep me signed in on this device')).toBeChecked()
  await dialog.getByLabel('Why').fill('a laptop was stolen')
  await dialog.getByRole('button', { name: 'Sign everyone out' }).click()
  await expect.poll(() => state.calls.find((c) => c.path === '/staff/sign-out-all')?.body).toEqual({ reason: 'a laptop was stolen', keepMe: true })
  await expect(page.getByText('3 people signed out')).toBeVisible()
})

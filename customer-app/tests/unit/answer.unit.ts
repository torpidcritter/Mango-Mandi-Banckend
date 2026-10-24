import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, readAnswer } from '../../src/answer.ts'

// The shop's reading of API answers, without a browser (TST-3).

const refused = (status: number, text: string) => {
  try {
    readAnswer(status, text)
  } catch (err) {
    assert.ok(err instanceof ApiError)
    return err
  }
  assert.fail('expected an ApiError')
}

test('a JSON answer is its data; an empty one is null', () => {
  assert.deepEqual(readAnswer(200, '{"orderId":"o1","total":129900}'), { orderId: 'o1', total: 129900 })
  assert.deepEqual(readAnswer(201, '[1,2]'), [1, 2])
  assert.equal(readAnswer(200, ''), null)
})

test("a refusal keeps the API's code, message and the rest as detail", () => {
  const err = refused(409, JSON.stringify({ error: { code: 'UNPAID_ORDER_EXISTS', message: 'You have an unpaid order (ORD-1).', requestId: 'r1', orderId: 'o1' } }))
  assert.equal(err.status, 409)
  assert.equal(err.code, 'UNPAID_ORDER_EXISTS')
  assert.equal(err.message, 'You have an unpaid order (ORD-1).')
  // Checkout links to the unpaid order from here.
  assert.equal(err.detail.orderId, 'o1')
})

test('a refusal without the error shape still reads as a message', () => {
  const err = refused(404, '{}')
  assert.equal(err.code, 'ERROR')
  assert.equal(err.message, 'Request failed (404)')
  assert.deepEqual(err.detail, {})
})

test("a proxy's HTML page is a message, never a SyntaxError", () => {
  const busy = refused(502, '<html><body>Bad Gateway</body></html>')
  assert.equal(busy.code, 'UNAVAILABLE')
  assert.match(busy.message, /busy right now/)
  const empty = refused(503, '')
  assert.equal(empty.code, 'UNAVAILABLE')
  // A 200 that isn't JSON (a host's own page) is not taken as data.
  const odd = refused(200, '<!doctype html><title>Welcome</title>')
  assert.equal(odd.code, 'BAD_RESPONSE')
  assert.match(odd.message, /could not read/)
  // A 4xx HTML page is not "busy": it keeps a plain message.
  const blocked = refused(403, '<html>Forbidden</html>')
  assert.equal(blocked.code, 'ERROR')
  assert.equal(blocked.message, 'Request failed (403)')
})

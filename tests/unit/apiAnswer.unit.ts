import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, errorFrom, parseAnswer } from '../../src/apiAnswer.ts'

// The panel's reading of API answers, without a browser (TST-3).

test("a refusal keeps the API's code, message and request id", () => {
  const err = errorFrom(409, 'Conflict', JSON.stringify({ error: { code: 'STALE_ATTEMPT', message: 'That attempt was already reported.', requestId: 'req-1' } }))
  assert.ok(err instanceof ApiError)
  assert.equal(err.name, 'ApiError')
  assert.deepEqual([err.status, err.code, err.message, err.requestId], [409, 'STALE_ATTEMPT', 'That attempt was already reported.', 'req-1'])
})

test('a refusal that is not the API JSON falls back to the status line', () => {
  const page = errorFrom(502, 'Bad Gateway', '<html><body>Bad Gateway</body></html>')
  assert.deepEqual([page.status, page.code, page.message, page.requestId], [502, 'HTTP_502', 'Bad Gateway', undefined])
  const bare = errorFrom(500, '', '')
  assert.deepEqual([bare.code, bare.message], ['HTTP_500', 'Request failed'])
  const partial = errorFrom(400, 'Bad Request', '{"error":{"code":"VALIDATION_ERROR"}}')
  assert.deepEqual([partial.code, partial.message], ['VALIDATION_ERROR', 'Bad Request'])
})

test('a JSON answer is its data; an empty one is undefined', () => {
  assert.deepEqual(parseAnswer(200, '{"id":"o1"}'), { id: 'o1' })
  assert.equal(parseAnswer(200, ''), undefined)
})

test("a 200 that isn't JSON (a proxy's page) is an ApiError, not a SyntaxError", () => {
  assert.throws(
    () => parseAnswer(200, '<!doctype html><title>Sign in to the Wi-Fi</title>'),
    (err: unknown) => err instanceof ApiError && err.code === 'BAD_RESPONSE' && err.status === 200 && /could not read/.test(err.message),
  )
})

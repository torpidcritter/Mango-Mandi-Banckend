import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportBuildProblem, supportDigits } from '../../src/support.ts'

// UX-1: a production shop build cannot ship without a help contact.

test('the help number is digits with the country code', () => {
  assert.equal(supportDigits('+91 98765 43210'), '919876543210')
  assert.equal(supportDigits('91-98765-43210'), '919876543210')
  assert.equal(supportDigits('9876543210'), null, 'no country code: wa.me would open the wrong number')
  assert.equal(supportDigits('call us'), null)
  assert.equal(supportDigits(undefined), null)
})

test('a production build fails with a clear message when the number is missing or wrong', () => {
  const missing = supportBuildProblem({ command: 'build', mode: 'production', value: undefined })
  assert.match(missing!, /VITE_SUPPORT_WHATSAPP is not set/)
  assert.match(supportBuildProblem({ command: 'build', mode: 'production', value: '' })!, /not set/)
  assert.match(supportBuildProblem({ command: 'build', mode: 'production', value: '12345' })!, /not a WhatsApp number/)
  assert.equal(supportBuildProblem({ command: 'build', mode: 'production', value: '919876543210' }), null)
})

test('dev servers and non-production builds keep working without it', () => {
  assert.equal(supportBuildProblem({ command: 'serve', mode: 'development', value: undefined }), null)
  assert.equal(supportBuildProblem({ command: 'build', mode: 'development', value: undefined }), null)
  assert.equal(supportBuildProblem({ command: 'build', mode: 'test', value: undefined }), null)
})

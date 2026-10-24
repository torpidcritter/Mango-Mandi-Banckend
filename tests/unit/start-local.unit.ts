import assert from 'node:assert/strict'
import { test } from 'node:test'

// SEC-01: the one-command local run (scripts/start-local.mjs) keeps the shop on
// this computer unless asked, and when it is shared (--phone, --wifi) the API's
// test stand-ins are off: no login codes in answers, /v1/dev not proxied.

interface Plan {
  link: boolean
  shared: boolean
  wifi: string[]
  api: Record<string, string>
  shopEnv: Record<string, string>
  shopCmd: string
}
const { localPlan } = (await import(new URL('../../scripts/start-local.mjs', import.meta.url).href)) as { localPlan: (argv: string[], wifi?: string[]) => Plan }

test('by default nothing leaves this computer: no link, no Wi-Fi, codes on screen', () => {
  const p = localPlan(['node', 'start-local.mjs'], ['192.168.1.20'])
  assert.equal(p.link, false)
  assert.equal(p.shared, false)
  assert.deepEqual(p.wifi, [])
  assert.equal(p.shopEnv.SHOP_API_PROXY, undefined)
  assert.equal(p.shopEnv.VITE_API_URL, 'http://localhost:3000')
  assert.doesNotMatch(p.shopCmd, /--host/)
  assert.equal(p.api.CUSTOMER_ORIGIN, 'http://localhost:5174')
  assert.equal(p.api.OTP_CODE_IN_RESPONSE, undefined)
})

test('--no-phone (the old way to keep it local) still means local', () => {
  assert.equal(localPlan(['node', 'start-local.mjs', '--no-phone'], ['192.168.1.20']).shared, false)
})

test('--phone shares the shop, and the API keeps codes out of its answers', () => {
  const p = localPlan(['node', 'start-local.mjs', '--phone'], ['192.168.1.20'])
  assert.equal(p.link, true)
  assert.equal(p.shared, true)
  assert.deepEqual(p.wifi, ['192.168.1.20'])
  assert.equal(p.api.OTP_CODE_IN_RESPONSE, 'false')
  assert.equal(p.api.LOG_OTP_CODES, 'true')
  assert.equal(p.api.CUSTOMER_ORIGIN, 'http://localhost:5174,http://192.168.1.20:5174')
  assert.equal(p.shopEnv.SHOP_API_PROXY, 'http://localhost:3000')
  assert.equal(p.shopEnv.VITE_API_URL, '')
  assert.match(p.shopCmd, /--host 0\.0\.0\.0/)
})

test('--wifi shares on the Wi-Fi only, with the same protections', () => {
  const p = localPlan(['node', 'start-local.mjs', '--wifi'], ['10.0.0.5'])
  assert.equal(p.link, false)
  assert.equal(p.shared, true)
  assert.equal(p.api.OTP_CODE_IN_RESPONSE, 'false')
  assert.equal(p.shopEnv.SHOP_API_PROXY, 'http://localhost:3000')
})

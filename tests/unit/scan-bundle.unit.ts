import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Bundle safety: scripts/scan-bundle.mjs (the CI step after the builds) fails
// on secrets, dev routes, demo accounts and mock providers in a built bundle,
// and passes a clean one. Each injected example below must be caught.

interface Finding { rule: string; file?: string; match: string }
const scanner = (await import(new URL('../../scripts/scan-bundle.mjs', import.meta.url).href)) as {
  scanText: (text: string, o?: { forbidLocalhost?: boolean; secrets?: { name: string; value: string }[] }) => Finding[]
  scanDirs: (dirs: string[], o?: { forbidLocalhost?: boolean; secrets?: { name: string; value: string }[] }) => Finding[]
  secretValues: (env: Record<string, string | undefined>) => { name: string; value: string }[]
  main: (argv: string[]) => number
}
const rules = (text: string, o = {}) => scanner.scanText(text, o).map((f) => f.rule)

test('each injected example is caught by its rule', () => {
  const cases: [string, string][] = [
    ['const k="rzp_live_AbCdEf123456"', 'razorpay-live-key'],
    ['key:"rzp_test_AbCdEf123456"', 'razorpay-test-key'],
    ['"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"', 'private-key'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw', 'private-key'],
    ['fetch("postgres://mango_app:hunter2@ep-x-pooler.neon.tech/neondb")', 'postgres-url'],
    ['s="dev-only-change-me-0123456789abcdef"', 'dev-jwt-secret'],
    ['x="whsec_abcdef1234"', 'webhook-secret'],
    ['t="vercel_blob_rw_AbCdEf0123456789"', 'blob-token'],
    ['a="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1fMTIzIn0.c2lnbmF0dXJlc2lnbmF0dXJl"', 'jwt'],
    ['console.log(process.env.JWT_SECRET)', 'secret-name'],
    ['post("/v1/dev/pay",{orderId})', 'dev-route'],
    ['id:"pay_dev_123"', 'dev-payment'],
    ['email:"manager@mandimangoes.test"', 'demo-account'],
    ['password:"manager123"', 'demo-password'],
    ['import "./mock-api"', 'mock-provider'],
    ['navigator.serviceWorker.register("/mockServiceWorker.js")', 'mock-provider'],
  ]
  for (const [text, rule] of cases) assert.ok(rules(text).includes(rule), `${rule} should catch ${text}`)
})

test('library text that only looks alarming passes', () => {
  // jose checks the header text of a PEM; react-router uses a bare localhost as a URL base;
  // @vercel/blob names its own server-side token variable.
  assert.deepEqual(rules('if(e.indexOf("-----BEGIN PRIVATE KEY-----")!==0)throw new TypeError("pkcs8")'), [])
  assert.deepEqual(rules('new URL("http://localhost")', { forbidLocalhost: true }), [])
  assert.deepEqual(rules('const i=Dt("BLOB_READ_WRITE_TOKEN")'), [])
  assert.deepEqual(rules('const ss="https://api.mandimangoes.in";fetch(ss+"/v1/products")'), [])
})

test('a localhost API only fails a build that must not have one', () => {
  assert.deepEqual(rules('const api="http://localhost:3000"'), [])
  assert.deepEqual(rules('const api="http://localhost:3000"', { forbidLocalhost: true }), ['localhost-api'])
})

test('the value of a server secret from the build environment is caught, short values are ignored', () => {
  const secrets = scanner.secretValues({ JWT_SECRET: 'a'.repeat(40), CRON_SECRET: 'short', VITE_API_URL: 'https://api.example.in' })
  assert.deepEqual(secrets.map((s) => s.name), ['JWT_SECRET'])
  const found = scanner.scanText(`const x="${'a'.repeat(40)}"`, { secrets })
  assert.deepEqual(found.map((f) => f.rule), ['secret-value'])
  assert.doesNotMatch(found[0].match, /aaaa/) // never printed
})

test('scanning folders: a clean build passes, an injected file and a source map fail', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-bundle-'))
  try {
    mkdirSync(path.join(root, 'assets'))
    writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/assets/index.js"></script>')
    writeFileSync(path.join(root, 'assets', 'index.js'), 'fetch("https://api.example.in/v1/products")')
    writeFileSync(path.join(root, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    assert.deepEqual(scanner.scanDirs([root], { secrets: [] }), [])
    assert.equal(scanner.main([root]), 0)

    writeFileSync(path.join(root, 'assets', 'leak.js'), 'const demo={email:"ops@mandimangoes.test",key:"rzp_live_ZZZZZZZZZZ"}')
    writeFileSync(path.join(root, 'assets', 'index.js.map'), '{}')
    const found = scanner.scanDirs([root], { secrets: [] })
    assert.deepEqual(found.map((f) => f.rule).sort(), ['demo-account', 'razorpay-live-key', 'source-map'])
    assert.ok(found.every((f) => f.file?.startsWith(root)))
    assert.equal(scanner.main([root]), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing folder is a usage error, not a pass', () => {
  assert.equal(scanner.main([path.join(tmpdir(), 'no-such-dist-folder')]), 2)
  assert.equal(scanner.main([]), 2)
})

test('--forbid-localhost-in-production fails only Vercel production builds', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-env-'))
  const saved = process.env.VERCEL_ENV
  try {
    writeFileSync(path.join(root, 'index.js'), 'const api="http://localhost:3000"')
    delete process.env.VERCEL_ENV
    assert.equal(scanner.main([root, '--forbid-localhost-in-production']), 0)
    process.env.VERCEL_ENV = 'preview'
    assert.equal(scanner.main([root, '--forbid-localhost-in-production']), 0)
    process.env.VERCEL_ENV = 'production'
    assert.equal(scanner.main([root, '--forbid-localhost-in-production']), 1)
  } finally {
    if (saved === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = saved
    rmSync(root, { recursive: true, force: true })
  }
})

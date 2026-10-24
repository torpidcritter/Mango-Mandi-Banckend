import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'
import { cspPlugin, header, policy, preconnectTags, type App } from '../scripts/csp'

// SEC-10: both apps send a Content-Security-Policy. The policy is written once
// in scripts/csp.ts; vercel.json carries a copy, which must not drift. Every
// panel spec runs under the dev server's policy, and the fixture fails a test
// on any console error, so a violation ("Refused to load ...") fails the suite.

const root = path.join(__dirname, '..')
const vercelCsp = (file: string) => {
  const cfg = JSON.parse(readFileSync(path.join(root, file), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
  return cfg.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')?.value
}

for (const [file, app] of [
  ['vercel.json', 'panel'],
  ['customer-app/vercel.json', 'shop'],
] as [string, App][]) {
  test(`${file} sends the ${app} policy from scripts/csp.ts`, () => {
    expect(vercelCsp(file)).toBe(header(app))
  })
}

test('the policies allow what each app loads, and nothing inline', () => {
  const shop = policy('shop', { api: 'https://api.mandimangoes.in' })
  expect(shop).toMatch(/script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client https:\/\/checkout\.razorpay\.com https:\/\/challenges\.cloudflare\.com;/)
  expect(shop).toContain('connect-src \'self\' https://api.mandimangoes.in ')
  expect(shop).toContain('frame-src https://accounts.google.com https://*.razorpay.com https://challenges.cloudflare.com')
  expect(shop).toContain('img-src \'self\' data: blob: https://api.mandimangoes.in https://*.public.blob.vercel-storage.com')
  expect(shop).toContain("frame-ancestors 'none'")
  const panel = policy('panel', { api: 'https://api.mandimangoes.in', meta: true })
  expect(panel).not.toContain('razorpay')
  expect(panel).not.toContain('frame-ancestors') // not allowed in a <meta> tag
  for (const p of [shop, panel, header('shop'), header('panel')]) {
    expect(p.match(/script-src [^;]*/)![0]).not.toContain('unsafe')
    expect(p).toContain("object-src 'none'")
  }
})

test('the built index.html of both apps preconnects to the API', () => {
  for (const app of ['panel', 'shop'] as App[]) {
    const hook = cspPlugin(app, 'https://api.mandimangoes.in/').transformIndexHtml as { handler: (html: string, ctx: object) => unknown }
    const tags = hook.handler('', {}) as { tag: string; attrs: Record<string, string | boolean> }[]
    const links = tags.filter((t) => t.tag === 'link').map((t) => t.attrs)
    expect(links).toEqual([
      { rel: 'preconnect', href: 'https://api.mandimangoes.in' },
      { rel: 'preconnect', href: 'https://api.mandimangoes.in', crossorigin: true },
      { rel: 'dns-prefetch', href: 'https://api.mandimangoes.in' },
    ])
    expect(tags[0].attrs['http-equiv']).toBe('Content-Security-Policy')
    // The dev server sends the header and adds nothing to the page.
    expect(hook.handler('', { server: {} })).toEqual([])
  }
  // No API configured: no hint to a guessed address.
  expect(preconnectTags(undefined)).toEqual([])
  expect(preconnectTags('not a url')).toEqual([])
})

test('the dev server sends the policy', async ({ page }) => {
  const res = await page.goto('/')
  const csp = res!.headers()['content-security-policy']
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain('https://accounts.google.com/gsi/client')
})

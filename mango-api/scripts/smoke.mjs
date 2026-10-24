#!/usr/bin/env node
// Post-deploy smoke test: read-only checks against a live API, shop and panel.
//
//   npm run smoke -- --api https://api.mandimangoes.in --shop https://mandimangoes.in --panel https://ops.mandimangoes.in
//   npm run smoke -- --api http://localhost:3121 --origins https://shop.x,https://ops.x --local   (a local production-mode API)
//
// Options:
//   --api <url>          the API (required)
//   --shop <url>         the customer shop; its origin is also expected in CORS
//   --panel <url>        the staff panel; its origin is also expected in CORS
//   --origins <a,b>      the origins the API must allow (default: the shop's and the panel's)
//   --local              plain http on this computer: skips HTTPS redirect and HSTS, and a
//                        /metrics that answers (no Caddy or Vercel in front) only warns
//   --check-demo-login   also tries ONE sign-in as the seed's demo manager
//                        (manager@mandimangoes.test). It must be refused. Off by default:
//                        a refused try counts against that email's password limit.
//   --header "Name: v"   send this header on every request (repeatable), e.g. Vercel's
//                        x-vercel-protection-bypass for a protected preview
//   --json               print the results as JSON
//
// Nothing here changes data. Every request is one a stranger could send: the
// webhooks get unsigned bodies (refused before they are read), the dev route
// gets an empty body (refused by validation even where it exists), and the
// cookie check calls logout with no session (nothing to revoke; the answer
// still carries the cookie's flags). Exit code 1 when any check fails.
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { scanText } from '../../scripts/scan-bundle.mjs'

const EVIL_ORIGIN = 'https://smoke-check.invalid'
const MAINTENANCE_STALE_S = 300

const originOf = (u) => new URL(u).origin
const join = (base, path) => `${base.replace(/\/$/, '')}${path}`

/** Parses Set-Cookie into { name, value, attrs: { httponly: true, samesite: 'Lax', ... } }. */
export function parseSetCookie(header) {
  const [pair, ...parts] = String(header).split(';').map((s) => s.trim())
  const eq = pair.indexOf('=')
  const attrs = {}
  for (const p of parts) {
    const i = p.indexOf('=')
    attrs[(i < 0 ? p : p.slice(0, i)).toLowerCase()] = i < 0 ? true : p.slice(i + 1)
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs }
}

/** The checks one cookie must pass; returns the problems. */
export function cookieProblems(c, { name, path, local }) {
  const out = []
  if (!c) return [`no ${name} cookie in the answer`]
  if (!c.attrs.httponly) out.push('not HttpOnly')
  if (!c.attrs.secure && !local) out.push('not Secure')
  const ss = String(c.attrs.samesite ?? '').toLowerCase()
  if (!['lax', 'strict', 'none'].includes(ss)) out.push('no SameSite')
  if (ss === 'none' && !c.attrs.secure) out.push('SameSite=None without Secure')
  if (c.attrs.path !== path) out.push(`Path is ${c.attrs.path ?? '(none)'}, expected ${path}`)
  return out
}

/** Runs every check. `fetchImpl` is for tests. Returns [{ area, check, status: pass|fail|warn|skip|manual, detail }]. */
export async function runSmoke(opts, fetchImpl = fetch) {
  const { api, shop, panel, local = false, checkDemoLogin = false } = opts
  const origins = opts.origins?.length ? opts.origins : [shop, panel].filter(Boolean).map(originOf)
  const results = []
  const add = (area, check, status, detail = '') => results.push({ area, check, status, detail })
  const extra = opts.headers ?? {}
  const get = (url, init = {}) => fetchImpl(url, { redirect: 'manual', ...init, headers: { ...extra, ...(init.headers ?? {}) } })
  const json = async (r) => {
    try {
      return await r.json()
    } catch {
      return null
    }
  }
  /** Runs one check; a network error fails it instead of stopping the run. */
  const check = async (area, name, fn) => {
    try {
      await fn()
    } catch (err) {
      add(area, name, 'fail', `request failed: ${err.cause?.code ?? err.message}`)
    }
  }

  // ------------------------------------------------------------ API
  await check('api', 'GET /health answers ok', async () => {
    const r = await get(join(api, '/health'))
    const b = await json(r)
    add('api', 'GET /health answers ok', r.status === 200 && b?.ok === true ? 'pass' : 'fail', `HTTP ${r.status}`)
    // Security headers, from the API's own answer (helmet).
    const h = r.headers
    const missing = []
    if (h.get('x-content-type-options') !== 'nosniff') missing.push('X-Content-Type-Options: nosniff')
    if (!h.get('x-frame-options')) missing.push('X-Frame-Options')
    if (!h.get('content-security-policy')) missing.push('Content-Security-Policy')
    if (!h.get('referrer-policy')) missing.push('Referrer-Policy')
    if (h.get('x-powered-by')) missing.push(`no X-Powered-By (got ${h.get('x-powered-by')})`)
    add('api', 'security headers', missing.length ? 'fail' : 'pass', missing.length ? `missing: ${missing.join(', ')}` : 'nosniff, frame options, CSP, referrer policy; no X-Powered-By')
    const hsts = h.get('strict-transport-security')
    const maxAge = Number(/max-age=(\d+)/.exec(hsts ?? '')?.[1] ?? 0)
    if (local) add('api', 'HSTS', 'skip', 'plain http (--local)')
    else add('api', 'HSTS', maxAge >= 15_552_000 ? 'pass' : 'fail', hsts ? hsts : 'no Strict-Transport-Security header')
  })

  await check('api', 'GET /ready: database and maintenance', async () => {
    const r = await get(join(api, '/ready'))
    const b = await json(r)
    const age = b?.maintenanceAgeSeconds
    if (r.status !== 200 || b?.ready !== true) {
      add('api', 'GET /ready: database and maintenance', 'fail', `HTTP ${r.status} ${JSON.stringify(b)}: the database is down, or the maintenance job has not run for ${MAINTENANCE_STALE_S}s (scheduler, CRON_SECRET)`)
    } else if (age === null || age === undefined) {
      add('api', 'GET /ready: database and maintenance', 'warn', 'ready, but the maintenance job has never finished a run (fine only outside production)')
    } else {
      add('api', 'GET /ready: database and maintenance', age <= MAINTENANCE_STALE_S ? 'pass' : 'fail', `maintenance last ran ${age}s ago`)
    }
  })

  await check('api', 'unknown path: JSON 404, no stack trace', async () => {
    const r = await get(join(api, '/smoke-check-no-such-route'))
    const text = await r.text()
    const ok = r.status === 404 && /"NOT_FOUND"/.test(text) && !/\bat [\w.<>]+ \(|node_modules/.test(text)
    add('api', 'unknown path: JSON 404, no stack trace', ok ? 'pass' : 'fail', `HTTP ${r.status}`)
  })

  await check('api', 'dev routes absent (/v1/dev)', async () => {
    // An empty body: where /v1/dev exists it is refused by validation (400), so nothing is paid.
    const r = await get(join(api, '/v1/dev/pay'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    add('api', 'dev routes absent (/v1/dev)', r.status === 404 ? 'pass' : 'fail',
      r.status === 404 ? 'POST /v1/dev/pay is 404' : `POST /v1/dev/pay answered HTTP ${r.status}: the development payment routes are ON (ENABLE_DEV_ROUTES, NODE_ENV)`)
  })

  for (const origin of origins) {
    await check('api', `CORS allows ${origin}`, async () => {
      const r = await get(join(api, '/v1/products'), {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
      })
      const allow = r.headers.get('access-control-allow-origin')
      const creds = r.headers.get('access-control-allow-credentials')
      add('api', `CORS allows ${origin}`, allow === origin && creds === 'true' ? 'pass' : 'fail', `Allow-Origin ${allow ?? '(none)'}, credentials ${creds ?? '(none)'}`)
    })
  }
  if (!origins.length) add('api', 'CORS allows the shop and panel', 'skip', 'give --shop/--panel or --origins')
  for (const origin of [EVIL_ORIGIN, 'null']) {
    await check('api', `CORS refuses ${origin}`, async () => {
      const r = await get(join(api, '/v1/products'), { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
      const allow = r.headers.get('access-control-allow-origin')
      add('api', `CORS refuses ${origin}`, !allow ? 'pass' : 'fail', allow ? `Allow-Origin ${allow}` : 'no Allow-Origin header')
    })
  }

  // Refresh cookies: logout with no session revokes nothing but sends the cookie's flags.
  // From the site's own origin when the API is expected to allow it, else from an allowed one.
  const siteOrigin = (url, fallback) => (url && origins.includes(originOf(url)) ? originOf(url) : fallback)
  const cookieChecks = [
    ['staff', '/admin/v1/auth/logout', 'mango_admin_rt', '/admin/v1/auth', siteOrigin(panel, origins[origins.length - 1])],
    ['customer', '/v1/auth/logout', 'mm_customer_rt', '/v1/auth', siteOrigin(shop, origins[0])],
  ]
  for (const [who, path, name, cookiePath, origin] of cookieChecks) {
    const label = `${who} refresh cookie: HttpOnly, Secure, SameSite, Path`
    await check('api', label, async () => {
      const r = await get(join(api, path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: '{}' })
      const cookies = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')].filter(Boolean)).map(parseSetCookie)
      const c = cookies.find((x) => x.name === name)
      const problems = r.status === 204 ? cookieProblems(c, { name, path: cookiePath, local }) : [`logout answered HTTP ${r.status}`]
      add('api', label, problems.length ? 'fail' : 'pass', problems.length ? problems.join('; ') : `${name}: SameSite=${c.attrs.samesite}${local && !c.attrs.secure ? ' (Secure not checked: --local)' : ''}`)
    })
    await check('api', `${who} session routes refuse another site`, async () => {
      const r = await get(join(api, path), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EVIL_ORIGIN }, body: '{}' })
      add('api', `${who} session routes refuse another site`, r.status === 403 ? 'pass' : 'fail', `logout from ${EVIL_ORIGIN}: HTTP ${r.status}`)
    })
  }

  await check('api', 'maintenance job needs the cron secret', async () => {
    const a = await get(join(api, '/internal/maintenance'))
    const b = await get(join(api, '/internal/maintenance'), { headers: { Authorization: 'Bearer smoke-check-wrong-secret' } })
    add('api', 'maintenance job needs the cron secret', a.status === 401 && b.status === 401 ? 'pass' : 'fail', `no secret: HTTP ${a.status}, wrong secret: HTTP ${b.status}`)
  })

  await check('api', '/metrics not public', async () => {
    const r = await get(join(api, '/metrics'))
    if (r.status !== 200) add('api', '/metrics not public', 'pass', `HTTP ${r.status}`)
    else add('api', '/metrics not public', local ? 'warn' : 'fail', 'answers 200 without a token: set METRICS_TOKEN, or keep it behind Caddy (it is 404 on Vercel)')
  })

  await check('api', 'Razorpay webhook refuses unsigned bodies', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: {} })
    const unsigned = await get(join(api, '/webhooks/razorpay'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const forged = await get(join(api, '/webhooks/razorpay'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': '0'.repeat(64) }, body })
    const ok = unsigned.status === 400 && forged.status === 400
    add('api', 'Razorpay webhook refuses unsigned bodies', ok ? 'pass' : 'fail', `unsigned: HTTP ${unsigned.status}, bad signature: HTTP ${forged.status}`)
  })
  await check('api', 'WhatsApp webhook refuses unsigned bodies', async () => {
    const r = await get(join(api, '/webhooks/whatsapp'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"object":"whatsapp_business_account","entry":[]}' })
    const v = await get(join(api, '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=smoke-check-wrong&hub.challenge=1'))
    add('api', 'WhatsApp webhook refuses unsigned bodies', r.status === 401 && v.status === 403 ? 'pass' : 'fail', `unsigned POST: HTTP ${r.status}, wrong verify token: HTTP ${v.status}`)
  })

  if (checkDemoLogin) {
    await check('api', 'demo manager cannot sign in', async () => {
      const origin = siteOrigin(panel, origins[origins.length - 1])
      const r = await get(join(api, '/admin/v1/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ email: 'manager@mandimangoes.test', password: 'manager123' }),
      })
      add('api', 'demo manager cannot sign in', r.status === 401 ? 'pass' : 'fail',
        r.status === 401 ? 'refused (401)' : `HTTP ${r.status}: the demo staff accounts may be live. Run npm run preflight against this database now`)
    })
  } else {
    add('api', 'demo manager cannot sign in', 'manual', 'not tried (side effect: one password failure). Run `npm run preflight` against the database (it fails on any @mandimangoes.test staff), or pass --check-demo-login')
  }

  // ------------------------------------------------------------ shop and panel
  for (const [area, url] of [['shop', shop], ['panel', panel]]) {
    if (!url) continue
    await check(area, 'home page and headers', async () => {
      const r = await get(url)
      const html = await r.text()
      const h = r.headers
      add(area, 'home page answers', r.status === 200 && /<html/i.test(html) ? 'pass' : 'fail', `HTTP ${r.status}`)
      const csp = h.get('content-security-policy') ?? ''
      const cspProblems = []
      if (!csp) cspProblems.push('no Content-Security-Policy header')
      else {
        if (!/frame-ancestors 'none'/.test(csp)) cspProblems.push("no frame-ancestors 'none'")
        if (!/object-src 'none'/.test(csp)) cspProblems.push("no object-src 'none'")
        if (/script-src[^;]*'unsafe-inline'/.test(csp)) cspProblems.push("script-src allows 'unsafe-inline'")
      }
      const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(html)
      add(area, 'Content-Security-Policy', cspProblems.length ? 'fail' : 'pass', cspProblems.length ? cspProblems.join('; ') : `header${meta ? ' and <meta>' : ''}`)
      const missing = []
      if (h.get('x-content-type-options') !== 'nosniff') missing.push('X-Content-Type-Options')
      if (!h.get('x-frame-options')) missing.push('X-Frame-Options')
      if (!h.get('referrer-policy')) missing.push('Referrer-Policy')
      if (area === 'panel' && !/noindex/.test(h.get('x-robots-tag') ?? '')) missing.push('X-Robots-Tag: noindex')
      add(area, 'security headers', missing.length ? 'fail' : 'pass', missing.length ? `missing: ${missing.join(', ')}` : 'nosniff, frame options, referrer policy')
      const hsts = h.get('strict-transport-security')
      if (local) add(area, 'HSTS', 'skip', 'plain http (--local)')
      else add(area, 'HSTS', hsts ? 'pass' : 'fail', hsts ?? 'no Strict-Transport-Security header')

      // The deployed bundle: the entry script and the modules it preloads, with the CI scanner's rules.
      const base = new URL(url)
      const srcs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.js)["']/gi)].map((m) => new URL(m[1], base).href)
      const findings = scanText(html, { forbidLocalhost: !local }).map((f) => ({ ...f, file: 'index.html' }))
      for (const s of [...new Set(srcs)].filter((s) => new URL(s).origin === base.origin)) {
        const js = await (await get(s)).text()
        findings.push(...scanText(js, { forbidLocalhost: !local }).map((f) => ({ ...f, file: new URL(s).pathname })))
      }
      const found = [...new Set(findings.map((f) => `${f.file}: ${f.what}`))]
      add(area, 'deployed bundle: no secrets, dev routes or demo accounts', found.length ? 'fail' : 'pass',
        found.length ? found.slice(0, 5).join('; ') : `${srcs.length} script(s) scanned`)
    })
  }

  // ------------------------------------------------------------ HTTPS redirect
  for (const [area, url] of [['api', api], ['shop', shop], ['panel', panel]]) {
    if (!url) continue
    const u = new URL(url)
    if (u.protocol !== 'https:') {
      add(area, 'http redirects to https', local ? 'skip' : 'fail', local ? 'plain http (--local)' : `${url} is not https`)
      continue
    }
    await check(area, 'http redirects to https', async () => {
      const plain = `http://${u.host}${area === 'api' ? '/health' : '/'}`
      const r = await get(plain)
      const loc = r.headers.get('location') ?? ''
      add(area, 'http redirects to https', [301, 302, 307, 308].includes(r.status) && loc.startsWith('https://') ? 'pass' : 'fail', `${plain}: HTTP ${r.status} ${loc}`)
    })
  }
  return results
}

const MARK = { pass: 'ok   ', fail: 'FAIL ', warn: 'warn ', skip: 'skip ', manual: 'check' }

export async function main(argv = process.argv.slice(2), fetchImpl = fetch, log = console.log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      api: { type: 'string' }, shop: { type: 'string' }, panel: { type: 'string' }, origins: { type: 'string' },
      local: { type: 'boolean', default: false }, 'check-demo-login': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
      header: { type: 'string', multiple: true },
    },
  })
  const headers = {}
  for (const h of values.header ?? []) {
    const i = h.indexOf(':')
    if (i < 1) {
      log(`--header needs "Name: value" (got ${h.split(':')[0]})`)
      return 2
    }
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim()
  }
  if (!values.api) {
    log('usage: npm run smoke -- --api <url> [--shop <url>] [--panel <url>] [--origins a,b] [--local] [--check-demo-login] [--header "Name: value"] [--json]')
    return 2
  }
  const origins = (values.origins ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const results = await runSmoke({ api: values.api, shop: values.shop, panel: values.panel, origins, headers, local: values.local, checkDemoLogin: values['check-demo-login'] }, fetchImpl)
  const failed = results.filter((r) => r.status === 'fail')
  if (values.json) log(JSON.stringify({ ok: !failed.length, results }, null, 2))
  else {
    for (const r of results) log(`${MARK[r.status]} ${r.area.padEnd(5)} ${r.check}${r.detail ? `: ${r.detail}` : ''}`)
    log(failed.length ? `\n${failed.length} check(s) failed. Roll back or fix before taking orders (deploy/RELEASE.md).` : '\nSmoke test passed.')
  }
  return failed.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}

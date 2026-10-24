// Load tests only: `node --import ./ops/load/provider-redirect.js src/index.js`.
// Every outside provider the production settings switch on is sent to the
// local stub (stub-providers.js) instead, so a load test never reaches them:
//   api.razorpay.com                          -> STUB/razorpay
//   challenges.cloudflare.com (Turnstile)     -> STUB/turnstile
// Anything else for those hosts, and Sentry's ingest hosts, is refused.
// The app code is unchanged; only the host is swapped.
const STUB = process.env.LOAD_STUB_URL || 'http://127.0.0.1:3145'
const real = globalThis.fetch

const ROUTES = [
  [/^https?:\/\/api\.razorpay\.com/i, `${STUB}/razorpay`],
  [/^https?:\/\/challenges\.cloudflare\.com\/turnstile\/v0/i, `${STUB}/turnstile`],
]

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  for (const [from, to] of ROUTES) if (from.test(url)) return real(url.replace(from, to), init)
  if (/razorpay\.com|cloudflare\.com|sentry\.io/i.test(url)) return Promise.reject(new Error(`load test: refusing to call ${url}`))
  return real(input, init)
}

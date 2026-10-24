// Content-Security-Policy for the staff panel and the shop (SEC-10).
//
// One policy per app, in two places:
// - a response header (vercel.json, and the Vite dev and preview servers), which
//   also carries frame-ancestors; vercel.json cannot know the API's address, so
//   the header allows any https: API (`api: null`);
// - a <meta> tag that `cspPlugin` writes into the built index.html with the
//   exact API origin from VITE_API_URL. Browsers enforce both, so the stricter
//   connect-src and img-src of the meta tag win wherever the app is hosted
//   (Vercel or the Caddy images in deploy/).
// tests/csp.spec.ts checks that vercel.json matches header() below.
//
// The same plugin also writes a preconnect hint for the API into the built
// index.html, so the browser opens the connection to the API while it is still
// fetching the app's script instead of after it.
import type { HtmlTagDescriptor, Plugin } from 'vite'

export type App = 'panel' | 'shop'

const SENTRY = ['https://*.ingest.sentry.io', 'https://*.ingest.us.sentry.io', 'https://*.ingest.de.sentry.io']
const GOOGLE = 'https://accounts.google.com'
const RAZORPAY = 'https://*.razorpay.com'
const RAZORPAY_CHECKOUT = 'https://checkout.razorpay.com'
const TURNSTILE = 'https://challenges.cloudflare.com'
// Photos may be served from Vercel Blob directly; profile pictures in the Google button.
const IMAGES = ['https://*.public.blob.vercel-storage.com', 'https://*.googleusercontent.com']

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

interface Options {
  /** The API's URL; null for "any https: origin" (the static vercel.json header). */
  api: string | null
  /** Vite's dev server: its inline React-refresh preamble and HMR websocket. */
  dev?: boolean
  /** For the <meta> tag, which may not carry frame-ancestors. */
  meta?: boolean
}

export function policy(app: App, { api, dev = false, meta = false }: Options): string {
  const apiSrc = api === null ? ['https:'] : [originOf(api)].filter((x): x is string => Boolean(x))
  const shop = app === 'shop'
  const d: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `${GOOGLE}/gsi/client`, ...(shop ? [RAZORPAY_CHECKOUT, TURNSTILE] : []), ...(dev ? ["'unsafe-inline'"] : [])],
    // Google's button and Razorpay's sheet add their own inline styles.
    'style-src': ["'self'", "'unsafe-inline'", `${GOOGLE}/gsi/style`],
    'img-src': ["'self'", 'data:', 'blob:', ...apiSrc, ...IMAGES, ...(shop ? [RAZORPAY] : [])],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...apiSrc, `${GOOGLE}/gsi/`, ...SENTRY, ...(shop ? [RAZORPAY] : []), ...(dev ? ['ws:', 'wss:'] : [])],
    'frame-src': [GOOGLE, ...(shop ? [RAZORPAY, TURNSTILE] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", ...(shop ? [RAZORPAY] : [])],
  }
  if (!meta) d['frame-ancestors'] = ["'none'"]
  return Object.entries(d)
    .map(([k, v]) => `${k} ${[...new Set(v)].join(' ')}`)
    .join('; ')
}

/** The header vercel.json sends: any https: API. */
export const header = (app: App) => policy(app, { api: null })

/**
 * <link rel="preconnect"> (and a dns-prefetch fallback) for the API's origin.
 * Two preconnects: the apps call the API with cookies (credentials: 'include'),
 * while CORS preflights and the plain config call go without, and browsers
 * keep those connections apart.
 */
export function preconnectTags(apiUrl: string | null | undefined): HtmlTagDescriptor[] {
  const origin = originOf(apiUrl)
  if (!origin) return []
  return [
    { tag: 'link', attrs: { rel: 'preconnect', href: origin }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: true }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'dns-prefetch', href: origin }, injectTo: 'head' },
  ]
}

/**
 * Serves the policy from `vite` and `vite preview`, and writes the exact-API
 * <meta> tag and the API preconnect hints into the built index.html.
 */
export function cspPlugin(app: App, apiUrl: string | undefined): Plugin {
  const api = apiUrl ?? 'http://localhost:3000'
  return {
    name: 'mango-csp',
    configureServer(server) {
      const value = policy(app, { api, dev: true })
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', value)
        next()
      })
    },
    configurePreviewServer(server) {
      const value = policy(app, { api })
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', value)
        next()
      })
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (ctx.server) return [] // the dev server sends the header instead
        return [
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy(app, { api, meta: true }) }, injectTo: 'head-prepend' },
          // Only for a configured API: a build without VITE_API_URL can't reach one anyway.
          ...preconnectTags(apiUrl),
        ]
      },
    },
  }
}

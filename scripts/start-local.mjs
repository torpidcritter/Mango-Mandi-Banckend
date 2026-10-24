// Runs all of MandiMangoes on this computer with one command, on Windows, Mac or Linux:
// a private Postgres (downloaded by npm, nothing to install), the API with demo data,
// the shop and the staff panel, then opens them in the browser.
//
//   node scripts/start-local.mjs            (add --no-open to skip the browser)
//   node scripts/start-local.mjs --phone    (also open the shop on your phone, see below)
//   node scripts/start-local.mjs --wifi     (the shop on this Wi-Fi only, no public link)
//
// Ctrl+C or closing the window stops everything. Data is kept in .local/ between runs.
// By default everything stays on this computer. --phone also makes a temporary public link
// (https://….trycloudflare.com) to the shop that works on any network, and shares the shop on
// this Wi-Fi. Anyone who has that link can use the shop, so with --phone (and --wifi) the test
// stand-ins are switched off (SEC-01): sign-in codes are printed in this window instead of on
// screen, and the test-mode pay route (/v1/dev) is not reachable through the shop.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const local = path.join(root, '.local')
const DB_PORT = 54329
/** This computer's private addresses (192.168.x / 10.x / 172.16-31.x): a phone on the same Wi-Fi uses one. */
function wifiAddresses() {
  const all = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal)
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9)
  return [...new Set(all.map((a) => a.address))].filter((ip) => rank(ip) < 9).sort((a, b) => rank(a) - rank(b))
}
const SHOP = 'http://localhost:5174'
const PANEL = 'http://localhost:5173'
const API = 'http://localhost:3000'

/**
 * What to start for these command-line flags (unit-tested in tests/unit/start-local.unit.ts).
 * The shop leaves this computer only when asked: --phone (public link and Wi-Fi) or --wifi.
 * Then the API runs without its test stand-ins that would be open to anyone on the link.
 */
export function localPlan(argv, wifiIps = []) {
  const link = argv.includes('--phone')
  const shared = link || argv.includes('--wifi')
  const wifi = shared ? wifiIps : []
  const api = {
    NODE_ENV: 'development',
    COOKIE_SECURE: 'false',
    // The shop's test-mode pay buttons use /v1/dev (on this computer only: see shopEnv).
    ENABLE_DEV_ROUTES: 'true',
    LOG_LEVEL: 'warn',
    // The shop opened from a phone (http://<wifi address>:5174) is allowed too.
    CUSTOMER_ORIGIN: [SHOP, ...wifi.map((ip) => `http://${ip}:5174`)].join(','),
    // Shared: login codes stay out of the API's answers and are printed here instead.
    ...(shared ? { OTP_CODE_IN_RESPONSE: 'false', LOG_OTP_CODES: 'true', SMS_PROVIDER: 'log' } : {}),
  }
  // Shared, the shop calls its own address and Vite passes /v1 (never /v1/dev) to the API, so
  // phones need only port 5174. On this computer alone it calls the API directly.
  const shopEnv = shared ? { VITE_API_URL: '', SHOP_API_PROXY: API } : { VITE_API_URL: API }
  const shopCmd = `npx vite --config customer-app/vite.config.ts --port 5174 --strictPort --force${wifi.length ? ' --host 0.0.0.0' : ''}`
  return { link, shared, wifi, api, shopEnv, shopCmd }
}

const PLAN = localPlan(process.argv, process.argv.includes('--phone') || process.argv.includes('--wifi') ? wifiAddresses() : [])
const PHONE = PLAN.link
const WIFI = PLAN.wifi
const children = []

const say = (msg) => console.log(`\n==> ${msg}`)

/** True when nothing on this computer answers on the port (checked on both localhost addresses). */
async function portFree(port) {
  const answers = (host) =>
    new Promise((resolve) => {
      const sock = connect({ port, host })
      sock.setTimeout(1000)
      sock.once('connect', () => (sock.destroy(), resolve(true)))
      sock.once('timeout', () => (sock.destroy(), resolve(false)))
      sock.once('error', () => resolve(false))
    })
  return !(await answers('127.0.0.1')) && !(await answers('::1'))
}

/** Runs a command to completion (npm needs a shell on Windows). */
function run(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { cwd, shell: true, stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`"${cmd}" failed (exit ${code})`))))
  })
}

/** Starts a long-running command and keeps it until this script exits. */
function start(cmd, cwd, env = {}, quiet = false) {
  const p = spawn(cmd, { cwd, shell: true, stdio: quiet ? 'ignore' : 'inherit', env: { ...process.env, ...env } })
  children.push(p)
  p.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n"${cmd}" stopped (exit ${code}). Stopping everything.`)
      stop(1)
    }
  })
  return p
}

async function waitFor(url, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${url} did not answer after ${seconds} seconds`)
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).unref()
}

let stopping = false
let db = null
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const p of children) {
    try {
      if (process.platform === 'win32') spawn(`taskkill /pid ${p.pid} /T /F`, { shell: true, stdio: 'ignore' })
      else p.kill()
    } catch {}
  }
  await db?.stop().catch(() => {})
  process.exit(code)
}
async function main() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Node 22 or newer is needed (this is ${process.versions.node})`)

  // An older window still running would keep serving old pages (often a blank screen) on these ports.
  for (const port of [3000, 5173, 5174, DB_PORT]) {
    if (!(await portFree(port))) {
      throw new Error(`MandiMangoes is already running in another window (port ${port} is busy). Close that window first, then run this again.`)
    }
  }

  if (!existsSync(path.join(root, 'node_modules'))) {
    say('Installing the shop and staff panel (first run only, a few minutes)')
    await run('npm ci --no-audit --no-fund --loglevel=error', root)
  }
  if (!existsSync(path.join(root, 'mango-api', 'node_modules'))) {
    say('Installing the API (first run only)')
    await run('npm ci --no-audit --no-fund --loglevel=error', path.join(root, 'mango-api'))
  }
  mkdirSync(local, { recursive: true })
  if (!existsSync(path.join(local, 'node_modules', 'embedded-postgres'))) {
    say('Downloading the database (first run only)')
    if (!existsSync(path.join(local, 'package.json'))) writeFileSync(path.join(local, 'package.json'), '{ "private": true }\n')
    await run('npm install embedded-postgres@16.14.0-beta.17 --no-audit --no-fund --loglevel=error', local)
  }
  if (PHONE && !existsSync(path.join(local, 'node_modules', 'cloudflared'))) {
    say('Downloading the phone link tool (first run only)')
    await run('npm install cloudflared@0.7.3 --no-audit --no-fund --loglevel=error', local).catch(() => console.log('   (could not download it; the phone link is skipped)'))
  }

  say('Starting the database')
  const req = createRequire(path.join(local, 'package.json'))
  const { default: EmbeddedPostgres } = await import(pathToFileURL(req.resolve('embedded-postgres')).href)
  const dataDir = path.join(local, 'pgdata')
  const fresh = !existsSync(dataDir)
  db = new EmbeddedPostgres({ databaseDir: dataDir, user: 'mango', password: 'mango', port: DB_PORT, persistent: true, onLog: () => {} })
  if (fresh) await db.initialise()
  await db.start()
  if (fresh) await db.createDatabase('mango')

  say('Starting the API (it adds demo stock and staff logins)')
  start('node src/index.js', path.join(root, 'mango-api'), { DATABASE_URL: `postgres://mango:mango@localhost:${DB_PORT}/mango`, ...PLAN.api })
  await waitFor(`${API}/ready`)

  say('Starting the shop and the staff panel')
  start('npx vite --port 5173 --strictPort --force', root, { VITE_API_URL: API }, true)
  start(PLAN.shopCmd, root, PLAN.shopEnv, true)
  await waitFor(SHOP)
  await waitFor(PANEL)
  const phoneLink = PHONE ? await startPhoneLink() : null

  if (!process.argv.includes('--no-open')) {
    openBrowser(SHOP)
    openBrowser(PANEL)
  }
  console.log(`
MandiMangoes is running.
  Shop:         ${SHOP}   (${PLAN.shared ? 'the sign-in code is printed in this window' : 'the sign-in code shows on screen'})
  Staff panel:  ${PANEL}   (manager@mandimangoes.test / manager123)
${PLAN.shared ? SHARED_WARNING : '\nTo open the shop on your phone too, start it with --phone.\n'}
${
    phoneLink
      ? `
On your phone (Wi-Fi or mobile data), open:  ${phoneLink}
(A new link is made each time this starts. Anyone with the link can see this demo shop.)
`
      : ''
  }${
    WIFI.length
      ? `
Or, on the same Wi-Fi as this computer: ${WIFI.map((ip) => `http://${ip}:5174`).join('  or  ')}
`
      : ''
  }
Leave this window open. Press Ctrl+C or close it to stop.`)
}

const SHARED_WARNING = `
  WARNING: the shop is shared beyond this computer${PHONE ? ', on a public link anyone who has it can open' : ', on this Wi-Fi'}.
  Use demo data only, never real customers' details. Sign-in codes are printed in this window
  (not on screen), and test-mode payment (/v1/dev) is off through the shared shop.
  Stop it with Ctrl+C when you are done.
`

/** Opens a temporary public https link to the shop with Cloudflare's free quick tunnel; null if it fails. */
async function startPhoneLink() {
  let bin
  try {
    const req = createRequire(path.join(local, 'package.json'))
    ;({ bin } = await import(pathToFileURL(req.resolve('cloudflared')).href))
  } catch {
    return null
  }
  if (!bin || !existsSync(bin)) return null
  say('Making the phone link')
  // 127.0.0.1, not localhost: on Windows localhost can mean the IPv6 address, which the shop
  // (listening on 0.0.0.0 for the Wi-Fi) does not answer, and the link shows a 502.
  return new Promise((resolve) => {
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:5174'], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(p)
    const timer = setTimeout(() => resolve(null), 60_000)
    const read = (chunk) => {
      const m = String(chunk).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    }
    p.stdout.on('data', read)
    p.stderr.on('data', read)
    p.on('exit', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

// Run, unless a test imported this file for localPlan.
// (Compared as paths, ignoring case: Windows may spell the drive letter either way.)
const isMain = Boolean(process.argv[1]) && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
if (isMain) {
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  main().catch((err) => {
    console.error(`\nSomething went wrong: ${err.message}`)
    stop(1)
  })
}

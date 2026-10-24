// npm run preflight [-- --online]
// Prints every go-live problem with the current settings and database, then
// exits 1 if anything would stop the launch. --online also checks the Razorpay
// keys and the WhatsApp number against their APIs (read-only calls), and the
// database role's statement and idle-in-transaction time limits (OPS-29).
process.env.PREFLIGHT = '1'

const { deployEnv, env, isProd } = await import('./env.js')
const { checkProduction, checkRoleTimeouts } = await import('./preflight.js')
const { isPooledUrl, query, closePool } = await import('./db.js')
const { checkDatabaseEnvironment } = await import('./migrate.js')

const online = process.argv.includes('--online')
const { errors, warnings } = checkProduction(env)
const ok = []
if (!isProd) warnings.unshift(`NODE_ENV is ${env.NODE_ENV}: these are the checks a production start would make`)

try {
  await query('SELECT 1')
  ok.push('Database reachable')
  const tables = (await query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t
  const bootstrap = deployEnv === 'preview' ? Boolean(env.PREVIEW_ADMIN_EMAIL && env.PREVIEW_ADMIN_PASSWORD) : Boolean(env.ADMIN_BOOTSTRAP_EMAIL && env.ADMIN_BOOTSTRAP_PASSWORD)
  if (!tables) {
    if (bootstrap) ok.push('Empty database: the first start creates the tables and the first manager')
    else errors.push('Empty database and no ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD: nobody could sign in to the panel')
  }
  else {
    const staff = (await query('SELECT COUNT(*)::int AS n FROM admin_users')).rows[0].n
    if (staff === 0 && !bootstrap) {
      errors.push('No staff accounts and no ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD: nobody could sign in to the panel')
    } else ok.push(staff ? `${staff} staff account(s)` : 'First manager will be created from ADMIN_BOOTSTRAP_EMAIL')
    if (staff > 0 && env.ADMIN_BOOTSTRAP_PASSWORD) {
      warnings.push('ADMIN_BOOTSTRAP_PASSWORD is still set after the first manager was made: remove it from the environment')
    }
    try {
      ok.push(`Database belongs to ${await checkDatabaseEnvironment({ query })}`)
    } catch (err) {
      errors.push(err.message)
    }
    const demo = (await query("SELECT COUNT(*)::int AS n FROM admin_users WHERE email LIKE '%@mandimangoes.test'")).rows[0].n
    if (demo) errors.push(`${demo} demo staff login(s) (@mandimangoes.test) are in this database: use a fresh production database`)
    const pins = (await query('SELECT COUNT(*)::int AS n FROM pincodes WHERE active')).rows[0].n
    ok.push(`${pins} delivery pincode(s) active`)
    const slots = (await query('SELECT COUNT(*)::int AS n FROM delivery_slots WHERE active')).rows[0].n
    if (!slots) warnings.push('No delivery slots: checkout will not ask for a time window (add them on the Planning page)')
    if (!env.BACKUP_HEARTBEAT_EXPECTED) {
      warnings.push('BACKUP_HEARTBEAT_EXPECTED is off: a stopped nightly backup will not show in Needs attention or Sentry (deploy/VERCEL.md, Backups)')
    }
  }
} catch (err) {
  errors.push(`Database: ${err.message}`)
}

if (online) {
  // OPS-29: the role's time limits, as the app's own connections see them.
  try {
    const t = await checkRoleTimeouts(query, { pooled: isPooledUrl(env.DATABASE_URL) })
    ok.push(...t.ok)
    warnings.push(...t.warnings)
    errors.push(...t.errors)
  } catch (err) {
    errors.push(`Database time limits: ${err.message}`)
  }
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')
    const r = await fetch('https://api.razorpay.com/v1/orders?count=1', { headers: { Authorization: `Basic ${auth}` } }).catch((e) => e)
    if (r instanceof Error) errors.push(`Razorpay unreachable: ${r.message}`)
    else if (r.ok) ok.push('Razorpay keys accepted')
    else errors.push(`Razorpay rejected the keys (HTTP ${r.status})`)
  }
  if (env.WHATSAPP_PROVIDER === 'meta') {
    const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } }).catch((e) => e)
    if (r instanceof Error) errors.push(`WhatsApp unreachable: ${r.message}`)
    else if (r.ok) {
      const b = await r.json()
      ok.push(`WhatsApp number ${b.display_phone_number} (${b.verified_name}, quality ${b.quality_rating ?? 'unknown'})`)
    } else errors.push(`WhatsApp rejected the token or number ID (HTTP ${r.status})`)
  }
}

await closePool().catch(() => {})
for (const line of ok) console.log(`ok    ${line}`)
for (const line of warnings) console.log(`warn  ${line}`)
for (const line of errors) console.log(`FAIL  ${line}`)
console.log(errors.length ? `\n${errors.length} problem(s) to fix before launch.` : '\nReady to launch.')
process.exit(errors.length ? 1 : 0)

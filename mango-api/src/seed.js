// Reference data on every start (idempotent), staff logins outside production,
// and optional demo batches on an empty database.
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { addDays, now, todayIST } from './clock.js'
import { query, tx } from './db.js'
import { env, isProd } from './env.js'
import { newId } from './ids.js'
import { ledger } from './inventory.js'
import { logger } from './logger.js'

// Fresh mangoes: HSN 0804 50, nil GST. Prices are GST-inclusive paise.
const PRODUCTS = [
  ['ALP-3', 'Alphonso 3kg Box', 'Alphonso', '3kg', 189_900],
  ['ALP-5', 'Alphonso 5kg Box', 'Alphonso', '5kg', 299_900],
  ['BAD-3', 'Badami 3kg Box', 'Badami', '3kg', 129_900],
  ['BAD-5', 'Badami 5kg Box', 'Badami', '5kg', 199_900],
]

const PINCODES = [
  ['560001', 'Bengaluru', 'Central'],
  ['560008', 'Bengaluru', 'East'],
  ['560034', 'Bengaluru', 'South'],
  ['560038', 'Bengaluru', 'East'],
  ['560066', 'Bengaluru', 'East'],
  ['560076', 'Bengaluru', 'South'],
  ['560095', 'Bengaluru', 'South'],
  ['560102', 'Bengaluru', 'South'],
]

const DEMO_USERS = [
  ['manager@mandimangoes.test', 'manager123', 'MANAGER'],
  ['ops@mandimangoes.test', 'operator123', 'OPERATOR'],
  ['packer@mandimangoes.test', 'packer123', 'PACKER'],
  ['qc@mandimangoes.test', 'qc123', 'QC'],
]

export async function seed() {
  for (const [sku, name, variety, box, price] of PRODUCTS) {
    await query(
      `INSERT INTO products (sku, name, variety, box_size, price, gst_rate, hsn_code) VALUES ($1, $2, $3, $4, $5, 0, '08045020')
       ON CONFLICT (sku) DO NOTHING`,
      [sku, name, variety, box, price],
    )
  }
  for (const [pin, city, zone] of PINCODES) {
    await query('INSERT INTO pincodes (pincode, city, zone) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [pin, city, zone])
  }

  if (!isProd) {
    for (const [email, password, role] of DEMO_USERS) {
      await query('INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING', [
        newId('adm'), email, await bcrypt.hash(password, 10), role,
      ])
    }
  } else if (env.ADMIN_BOOTSTRAP_EMAIL && env.ADMIN_BOOTSTRAP_PASSWORD) {
    // First production start: create one manager if there are no staff yet.
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM admin_users')
    if (rows[0].n === 0) {
      await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1, $2, $3, 'MANAGER')`, [
        newId('adm'), env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase(), await bcrypt.hash(env.ADMIN_BOOTSTRAP_PASSWORD, 12),
      ])
      logger.info({ email: env.ADMIN_BOOTSTRAP_EMAIL }, 'bootstrap manager created')
    }
  }

  if (env.SEED_DEMO_DATA && !isProd) await seedDemoBatches()
  // Tests set up their own slots; development gets two to click through.
  if (env.SEED_DEMO_DATA && env.NODE_ENV === 'development') await seedDemoSlots()
}

async function seedDemoSlots() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM delivery_slots')
  if (rows[0].n > 0) return
  for (const [label, from, to, sort] of [['Morning', '07:00', '11:00', 1], ['Evening', '16:00', '20:00', 2]]) {
    await query('INSERT INTO delivery_slots (id, label, starts_at, ends_at, max_boxes, sort) VALUES ($1, $2, $3, $4, 40, $5)', [newId('slt'), label, from, to, sort])
  }
}

/** A rolling spread of batches so every stage has stock for the next few days. */
async function seedDemoBatches() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM batches')
  if (rows[0].n > 0) return
  const today = todayIST()
  const batches = [
    // [variety, age today, status, latest QC rating or null, farm, lines]
    ['Alphonso', 4, 'SELLING', 'SEMI_RIPE', 'Ratnagiri', { 'ALP-3': 40, 'ALP-5': 20 }],
    ['Alphonso', 2, 'ARRIVED', 'RAW', 'Devgad', { 'ALP-3': 40, 'ALP-5': 20 }],
    ['Alphonso', 0, 'IN_TRANSIT', null, 'Ratnagiri', { 'ALP-3': 30, 'ALP-5': 15 }],
    ['Badami', 5, 'SELLING', 'RIPE', 'Chittoor', { 'BAD-3': 30, 'BAD-5': 15 }],
    ['Badami', 2, 'ARRIVED', 'RAW', 'Krishnagiri', { 'BAD-3': 30, 'BAD-5': 15 }],
  ]
  await tx(async (c) => {
    for (const [variety, age, status, rating, farm, lines] of batches) {
      const id = newId('bat')
      const pluckedOn = addDays(today, -age)
      const arrived = status !== 'IN_TRANSIT'
      await c.query(
        'INSERT INTO batches (id, variety, plucked_on, farm, status, eta_date, arrived_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, variety, pluckedOn, farm, status, addDays(pluckedOn, 2), arrived ? now() : null],
      )
      for (const [sku, qty] of Object.entries(lines)) {
        await c.query('INSERT INTO batch_lines (id, batch_id, sku, on_hand) VALUES ($1, $2, $3, $4)', [newId('bl'), id, sku, qty])
        await ledger(c, { batchId: id, eventType: 'INTAKE', sku, delta: qty, actorType: 'system', actorId: 'seed', reason: 'Demo data' })
      }
      if (rating) {
        await c.query(
          `INSERT INTO batch_qc (id, batch_id, ripeness_rating, condition, notes, logged_by, logged_at) VALUES ($1, $2, $3, 'GOOD', 'Demo reading', 'seed', $4)`,
          [newId('qc'), id, rating, now()],
        )
      }
    }
  })
  logger.info('demo batches seeded')
}

// `npm run seed`: reference data (and, outside production, demo logins). On
// Vercel it runs in the API's build step after the migrations.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('./db.js')
  seed()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'seed failed')
      process.exit(1)
    })
}

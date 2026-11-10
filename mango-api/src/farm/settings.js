// Farm Experience settings (docs/farm-experience.md): farm details, the stay,
// meals, policies and FAQs. One row in farm_settings, edited by managers on the
// panel's Farm Settings page. Nothing is made up here: farm details start
// empty, and the shop says "confirmed by our team" until a manager fills them.
// The rules that protect money and stock (the 250 kg minimum, the hold) are
// not settings.
import { z } from 'zod'
import { now } from '../clock.js'
import { HttpError } from '../errors.js'

/** The business rule: no booking below this. Not a setting. */
export const MIN_KG = 250

/** The FAQ questions the spec asks for. Answers start empty: a manager writes them. */
const FAQ_QUESTIONS = [
  'Is there a minimum purchase?',
  'Can I bring my family?',
  'Can I bring a large group?',
  'Is accommodation included?',
  'Are meals included?',
  'Can I pick mangoes myself?',
  'Can I choose a particular variety?',
  'Can I purchase more than 250 kg?',
  'How do I transport my mangoes?',
  'What happens if the weather is unsuitable?',
  'What happens if the selected mango variety is unavailable?',
  'Can I reschedule my visit?',
  'Is advance payment mandatory?',
]

/** Answers that only restate the rules the system enforces; the rest wait for the business. */
const RULE_ANSWERS = {
  'Is there a minimum purchase?': `Yes. Every Farm Experience booking is for at least ${MIN_KG} kg of mangoes.`,
  'Can I purchase more than 250 kg?': 'Yes. Book any amount from 250 kg up, as long as that much of your variety is available for your date.',
  'Is advance payment mandatory?': 'Yes. The full price of your mangoes is paid online when you book. Your booking is confirmed only after the payment is verified.',
  'Can I bring a large group?': 'Yes. There is no fixed limit on your group. Tell us how many are coming and our team will plan rooms and meals with you before your visit.',
}

const text = (max) => z.string().trim().max(max).default('')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').or(z.literal('')).default('')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').or(z.literal('')).default('')

export const settingsSchema = z
  .object({
    // Shown on the landing page and itinerary.
    farmName: text(120),
    location: text(500),
    mapUrl: z.string().trim().max(500).refine((s) => s === '' || /^https:\/\//.test(s), 'The map link must start with https://').default(''),
    contactPhone: text(20),
    contactEmail: text(200),
    arrivalInstructions: text(2000),
    // The stay.
    checkInTime: time,
    checkOutTime: time,
    stayNights: z.number().int().min(0).max(30).default(0),
    sleepingArrangements: text(1500),
    bathroomFacilities: text(1500),
    otherFacilities: text(1500),
    groupCoordination: text(1500),
    // Meals included during the agreed stay.
    meals: z
      .object({ breakfast: z.boolean().default(false), lunch: z.boolean().default(false), dinner: z.boolean().default(false), refreshments: z.boolean().default(false) })
      .default({ breakfast: false, lunch: false, dinner: false, refreshments: false }),
    mealNotes: text(1500),
    // Transport is never promised: off and empty until the business says otherwise.
    transportIncluded: z.boolean().default(false),
    transportPolicy: text(1500),
    weatherPolicy: text(1500),
    harvestPolicy: text(1500),
    noShowPolicy: text(1500),
    // Season and booking window.
    seasonStart: date,
    seasonEnd: date,
    leadDays: z.number().int().min(0).max(60).default(3),
    maxDaysAhead: z.number().int().min(1).max(365).default(120),
    // Nothing is paid before the visit, so this caps how many upcoming visits one customer can hold at a time.
    maxOpenBookings: z.number().int().min(1).max(20).default(2),
    // A customer may cancel online this many days or more before the visit (nothing is charged);
    // later, the request goes to our team. Changing the visit date: the same, with its own number.
    cancelDays: z.number().int().min(0).max(120).default(7),
    rescheduleDays: z.number().int().min(0).max(120).default(3),
    // Extra mangoes picked on the day: price per kg from the variety unless this is set (paise).
    extraPricePerKg: z.number().int().min(1).max(10_000_000).nullable().default(null),
    // Charges for extra guests are not invented: none unless the business adds them here (shown as paid services).
    guestCharges: text(1000),
    faqs: z
      .array(z.object({ q: z.string().trim().min(3).max(200), a: z.string().trim().max(2000) }))
      .max(40)
      .default(FAQ_QUESTIONS.map((q) => ({ q, a: RULE_ANSWERS[q] ?? '' }))),
    // Customers can book only while this is on, and only once readinessProblems() is empty.
    bookingsOpen: z.boolean().default(false),
  })
  .strict()

export const DEFAULTS = settingsSchema.parse({})

/** The stored settings with defaults filled in (fields added later get theirs). */
export function settingsFrom(row) {
  const r = settingsSchema.safeParse({ ...DEFAULTS, ...(row?.data ?? {}) })
  return r.success ? r.data : { ...DEFAULTS, ...(row?.data ?? {}) }
}

export async function loadSettings(c, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT * FROM farm_settings WHERE id = 1${lock ? ' FOR UPDATE' : ''}`)
  return { settings: settingsFrom(rows[0]), version: rows[0]?.version ?? 1, updatedAt: rows[0]?.updated_at ?? null }
}

/**
 * What still has to be set before customers may book. Each is a plain sentence for the
 * Farm Settings page. Bookings can't be opened while any is left.
 */
export async function readinessProblems(c, s) {
  const out = []
  if (!s.farmName) out.push('Add the farm’s name.')
  if (!s.location) out.push('Add where the farm is.')
  if (!s.contactPhone) out.push('Add a contact phone number for visitors.')
  if (!s.arrivalInstructions) out.push('Add arrival instructions.')
  if (!s.checkInTime || !s.checkOutTime) out.push('Set the check-in and check-out times.')
  if (!s.sleepingArrangements) out.push('Describe the sleeping arrangements.')
  if (!s.bathroomFacilities) out.push('Describe the bathroom facilities.')
  if (!Object.values(s.meals).some(Boolean)) out.push('Choose which meals are included.')
  if (!s.transportPolicy) out.push('Write the transport policy (say plainly whether transport is included).')
  if (!s.weatherPolicy) out.push('Write what happens when the weather is unsuitable.')
  if (!s.seasonStart || !s.seasonEnd) out.push('Set the season’s first and last visit dates.')
  if (s.faqs.some((f) => !f.a)) out.push('Answer every FAQ (or remove the ones you don’t need).')
  const v = await c.query('SELECT COUNT(*)::int AS n FROM farm_varieties WHERE active')
  if (!v.rows[0].n) out.push('Add at least one variety with its price per kg.')
  const d = await c.query(
    `SELECT COUNT(*)::int AS n FROM farm_days d WHERE d.open AND d.day >= $1
        AND EXISTS (SELECT 1 FROM farm_harvest h JOIN farm_varieties v ON v.id = h.variety_id WHERE v.active AND h.day = d.day AND h.bookable_kg >= $2)`,
    [new Date(now().getTime()).toISOString().slice(0, 10), MIN_KG],
  )
  if (!d.rows[0].n) out.push(`Open at least one visit date with ${MIN_KG} kg or more bookable for a variety.`)
  const r = await c.query('SELECT COUNT(*)::int AS n FROM farm_rooms WHERE active')
  if (!r.rows[0].n) out.push('Add the farmhouse rooms.')
  return out
}

export async function saveSettings(c, patch, version, admin) {
  const cur = await loadSettings(c, { lock: true })
  if (version != null && version !== cur.version) {
    throw new HttpError(409, 'STALE_SETTINGS', 'Someone else changed the farm settings. Reload to see their change, then make yours again.', { version: cur.version })
  }
  const next = settingsSchema.parse({ ...cur.settings, ...patch })
  if (next.seasonStart && next.seasonEnd && next.seasonStart > next.seasonEnd) throw new HttpError(400, 'VALIDATION_ERROR', 'The season must end after it starts.')
  if (next.bookingsOpen && !cur.settings.bookingsOpen) {
    const problems = await readinessProblems(c, next)
    if (problems.length) throw new HttpError(409, 'FARM_NOT_READY', `Bookings can’t open yet: ${problems[0]}`, { problems })
  }
  const { rows } = await c.query(
    'UPDATE farm_settings SET data = $1, version = version + 1, updated_at = $2, updated_by = $3 WHERE id = 1 RETURNING version, updated_at',
    [JSON.stringify(next), now(), admin.email],
  )
  return { settings: next, version: rows[0].version, updatedAt: rows[0].updated_at, before: cur.settings }
}

/** What the shop may see: everything here is public information. */
export function publicSettings(s) {
  const { bookingsOpen: _b, ...rest } = s
  return { ...rest, faqs: s.faqs.filter((f) => f.a) }
}

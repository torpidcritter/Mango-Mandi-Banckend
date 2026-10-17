// The one source of "now". Tests shift it; everything else reads it.
// Business dates are IST calendar days as "YYYY-MM-DD" strings.

let offsetMs = 0

export const now = () => new Date(Date.now() + offsetMs)

/** Test hook: make now() return `at` (and keep ticking from there). null resets. */
export function setNow(at) {
  offsetMs = at == null ? 0 : new Date(at).getTime() - Date.now()
}

const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 86_400_000

/** IST calendar date and wall-clock time of an instant. */
export function istParts(d = now()) {
  const t = new Date(new Date(d).getTime() + IST_OFFSET_MS)
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() }
}

export const todayIST = (d = now()) => istParts(d).date

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** Whole days from b to a (a − b). */
export const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS)

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

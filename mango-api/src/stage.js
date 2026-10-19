// Ripeness engine (pure functions). A box's stage is never stored on stock:
// it is derived from the batch's age on the DELIVERY date, shifted by the
// latest QC reading, so the same box can sell as raw on one date and ripe on
// another. See the playbook, section 2.
import { addDays, diffDays, istParts } from './clock.js'

export const STAGES = ['RAW', 'SEMI_RIPE', 'RIPE']

const profileFor = (config, variety) => config.stageProfiles[variety] ?? config.stageProfiles.default

/** Stage index a profile predicts at an age: -1 before the first window, STAGES.length after the last. */
function predictedIndex(profile, age) {
  const hit = profile.find((p) => age >= p.minAge && age <= p.maxAge)
  if (hit) return STAGES.indexOf(hit.stage)
  if (age < profile[0].minAge) return -1
  if (age > profile[profile.length - 1].maxAge) return STAGES.length
  // A gap between windows: use the window before it.
  const before = profile.filter((p) => p.maxAge < age).at(-1)
  return STAGES.indexOf(before.stage)
}

/**
 * Days the latest QC reading moves the batch along its profile, clamped to
 * ±maxQcShift. A batch QC'd ripe when the profile expected semi-ripe is a
 * fast ripener: +1 day.
 */
export function qcShift(config, variety, pluckedOn, qc) {
  if (!qc) return 0
  const profile = profileFor(config, variety)
  const ageAtQc = diffDays(istParts(qc.loggedAt).date, pluckedOn)
  // Fruit is raw from the day it is plucked, even before it may be sold.
  const expected = Math.max(0, predictedIndex(profile, ageAtQc))
  const diff = STAGES.indexOf(qc.ripenessRating) - expected
  return Math.max(-config.maxQcShift, Math.min(config.maxQcShift, diff))
}

/**
 * The stage a batch sells as on a delivery date, or null if it can't be sold
 * then. `qc` is the latest reading ({ ripenessRating, loggedAt }) or null.
 */
export function stageFor(config, { variety, pluckedOn }, deliveryDate, qc) {
  const age = diffDays(deliveryDate, pluckedOn)
  if (age > config.maxSellableAge) return null // hard cap, checked on the delivery date
  const profile = profileFor(config, variety)
  const idx = predictedIndex(profile, age + qcShift(config, variety, pluckedOn, qc))
  if (idx < 0) return null
  // Still inside the cap but past the last window (a fast ripener): ripe.
  return STAGES[Math.min(idx, STAGES.length - 1)]
}

/** Days after delivery until a box sold at a stage is ready to eat, at room temperature. */
const DAYS_TO_READY = { RAW: 5, SEMI_RIPE: 2, RIPE: 0 }
/** Days a ripe mango stays good to eat once ready. */
export const READY_DAYS = 3

/**
 * When a box delivered on `deliveryDate` at `stage` is ready to eat, and the
 * last day to eat it. The one rule behind every "eat by" the shop, WhatsApp,
 * the panel and the box labels show.
 */
export function eatingWindow(stage, deliveryDate) {
  const readyFrom = addDays(deliveryDate, DAYS_TO_READY[stage] ?? 0)
  return { readyFrom, eatBy: addDays(readyFrom, READY_DAYS) }
}

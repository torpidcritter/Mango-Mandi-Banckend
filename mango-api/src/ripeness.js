// When a box is ready to eat, and how to keep it. Ripeness is sold by age on
// the delivery date (stage.js); from there raw boxes take about 5 days to
// ripen at home, semi-ripe about 2, and ripe ones are ready on arrival. These
// are the same days the "eat by" date has always assumed.
import { addDays } from './clock.js'

export const STAGE_WORDS = { RAW: 'raw', SEMI_RIPE: 'semi-ripe', RIPE: 'ripe' }

/** The first day a box delivered on `date` is ready to eat. */
export const readyOnFor = (stage, date) => addDays(date, { RAW: 5, SEMI_RIPE: 2, RIPE: 0 }[stage] ?? 0)

/** The last good day to eat it (kept in the fridge once ripe). */
export const eatByFor = (stage, date) => addDays(readyOnFor(stage, date), 3)

/** One storage line for the least ripe box in the order. */
export function storageTip(stages) {
  if (stages.includes('RAW')) return "Keep them at room temperature, out of the sun, and don't refrigerate them until they are ripe: cold stops ripening. A paper bag speeds it up."
  if (stages.includes('SEMI_RIPE')) return 'Leave them on the counter for a day or two until they smell sweet at the stem, then eat them or move them to the fridge.'
  return 'Ready to eat on arrival. Enjoy them within a day or two, or keep them in the fridge for 2 to 3 more days.'
}

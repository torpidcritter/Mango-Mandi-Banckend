// Farm Experience maintenance (docs/farm-experience.md), from the maintenance loop:
// a reminder two days before each confirmed visit (WHATSAPP_FARM_UPDATES).
// Bill payments still unpaid are reconciled with orders (payments.js), and
// refunds of money taken twice are sent by processDueRefunds.
import { addDays, now, todayIST } from '../clock.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { queueFarmMessages } from './notify.js'

export async function runFarmJobs(at = now()) {
  let reminded = 0
  if (env.WHATSAPP_FARM_UPDATES) {
    const day = addDays(todayIST(at), 2)
    const { rows } = await query(`SELECT * FROM farm_bookings WHERE visit_date = $1 AND status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_VISIT')`, [day])
    for (const b of rows) reminded += await tx((c) => queueFarmMessages(c, b, 'REMINDER', { tag: `reminder:${b.visit_date}` }))
  }
  return { reminded }
}

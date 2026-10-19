// A time budget for the maintenance run. A Vercel Function is stopped at 60
// seconds, so the run gets 45 and every loop checks what is left before it
// starts something slow (a Razorpay or WhatsApp call, a transaction). Work
// left over is picked up by the next run a minute later.
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage()

/** Runs fn with a deadline `ms` from now. */
export const withBudget = (ms, fn) => store.run({ deadline: Date.now() + ms }, fn)

/**
 * Runs fn with at most `ms` of what is left, so one slow step (a Razorpay
 * outage, a WhatsApp backlog) can't use up the run and starve the steps after it.
 */
export const withSlice = (ms, fn) => store.run({ deadline: Math.min(Date.now() + timeLeft(), Date.now() + ms) }, fn)

/** Milliseconds left in the current budget (Infinity outside one). */
export function timeLeft() {
  const s = store.getStore()
  return s ? s.deadline - Date.now() : Infinity
}

/** True when less than `needMs` is left: stop and leave the rest for the next run. */
export const outOfTime = (needMs = 0) => timeLeft() <= needMs

/** Test hook: shrink the current budget to `ms` from now. */
export function setBudget(ms) {
  const s = store.getStore()
  if (s) s.deadline = Date.now() + ms
}

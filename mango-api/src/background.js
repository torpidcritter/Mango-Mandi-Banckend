// Work that may finish after the response is sent. A Vercel Function can be
// frozen once it has answered, so this hands the promise to waitUntil, which
// keeps the instance alive until it settles. Only for small best-effort tasks:
// anything that must happen (customer messages) goes through an outbox table.
import { waitUntil } from '@vercel/functions'
import { onVercel } from './env.js'
import { logger } from './logger.js'

/** Tasks still running, so tests (and a clean shutdown) can wait for them. */
const pending = new Set()

export function background(promise) {
  const p = Promise.resolve(promise).catch((err) => logger.error({ err }, 'background task failed'))
  pending.add(p)
  p.finally(() => pending.delete(p))
  if (onVercel) {
    try {
      waitUntil(p)
    } catch {
      // Outside a request: nothing to keep alive.
    }
  }
}

/** Waits until every background task started so far (and any they start) has settled. */
export async function drainBackground() {
  while (pending.size) await Promise.allSettled([...pending])
}

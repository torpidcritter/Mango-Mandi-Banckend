// Error reporting to Sentry when SENTRY_DSN is set; otherwise errors are only logged.
import * as Sentry from '@sentry/node'
import { env } from './env.js'

const on = Boolean(env.SENTRY_DSN)
if (on) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
}

/** Reports an unexpected error with what we know about the request. */
export function reportError(err, context = {}) {
  if (!on) return
  Sentry.captureException(err, { extra: context })
}

/** Reports a condition that needs a person (stuck payments, failing messages). */
export function reportProblem(message, context = {}) {
  if (!on) return
  Sentry.captureMessage(message, { level: 'warning', extra: context })
}

/** Sends queued reports before a serverless function is frozen or a server exits. */
export const flushErrors = () => (on ? Sentry.flush(2000).catch(() => false) : Promise.resolve(true))



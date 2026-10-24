// Reading mango-api's answers: no fetch, no window, so it is unit tested on its
// own (customer-app/tests/unit/answer.unit.ts, run by `npm run test:unit`).

export class ApiError extends Error {
  status: number
  code: string
  detail: Record<string, unknown>
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/**
 * An answer's body (not a 204) as data, or the ApiError it stands for. A page
 * that isn't JSON (a proxy's or host's own error page) reads as a message,
 * never a SyntaxError.
 */
export function readAnswer<T>(status: number, text: string): T {
  const ok = status >= 200 && status < 300
  let json: { error?: { code?: string; message?: string } & Record<string, unknown> } | null = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: a proxy's or host's own error page.
    if (ok) throw new ApiError(status, 'BAD_RESPONSE', 'MandiMangoes sent an answer we could not read. Please try again.')
  }
  if (!ok) {
    if (json === null && status >= 500) {
      throw new ApiError(status, 'UNAVAILABLE', 'MandiMangoes is busy right now. Please try again in a minute.')
    }
    const e = json?.error
    throw new ApiError(status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${status})`, e ?? {})
  }
  return json as T
}

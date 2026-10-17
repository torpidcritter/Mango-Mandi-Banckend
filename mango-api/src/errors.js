// Errors that map to the API's { error: { code, message, requestId } } shape.

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export const badRequest = (message, code = 'VALIDATION_ERROR') => new HttpError(400, code, message)
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') => new HttpError(401, code, message)
export const forbidden = (message = 'Requires manager role') => new HttpError(403, 'FORBIDDEN', message)
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message)
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message)

export class StockError extends HttpError {
  constructor(sku) {
    super(409, 'STOCK_INSUFFICIENT', `Not enough stock for ${sku}`, { sku })
  }
}

/** Passes sync throws and rejected promises to Express's error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch(next)
}

/** Parses a zod schema, turning failures into a 400 VALIDATION_ERROR. */
export function parse(schema, value) {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const first = r.error.issues[0]
  const where = first.path.length ? `${first.path.join('.')}: ` : ''
  throw badRequest(`${where}${first.message}`)
}

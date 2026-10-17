import { randomUUID } from 'node:crypto'

/** Short, prefixed, sortable-enough ids: "bat_3f9c…". */
export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`

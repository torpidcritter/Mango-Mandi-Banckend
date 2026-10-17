import './setup-env.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RULES } from '../src/config.js'
import { stageFor } from '../src/stage.js'

const batch = { variety: 'Alphonso', pluckedOn: '2026-10-01' }
const on = (age) => `2026-10-${String(1 + age).padStart(2, '0')}`
const qcAt = (age, ripenessRating) => ({ ripenessRating, loggedAt: `${on(age)}T03:00:00Z` })

test('default windows: raw at 3, semi 4-5, ripe 6-7, nothing before 3 or after 7', () => {
  const got = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((a) => stageFor(DEFAULT_RULES, batch, on(a), null))
  assert.deepEqual(got, [null, null, null, 'RAW', 'SEMI_RIPE', 'SEMI_RIPE', 'RIPE', 'RIPE', null, null])
})

test('a fast ripener (QC ripe at age 5) shifts one day ahead', () => {
  const qc = qcAt(5, 'RIPE')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(5), qc), 'RIPE')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(4), qc), 'SEMI_RIPE')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(2), qc), 'RAW')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(7), qc), 'RIPE', 'still inside the 7-day cap')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(8), qc), null, 'the cap never moves')
})

test('a slow ripener (QC raw at age 4) shifts one day back', () => {
  const qc = qcAt(4, 'RAW')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(4), qc), 'RAW')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(3), qc), null)
  assert.equal(stageFor(DEFAULT_RULES, batch, on(6), qc), 'SEMI_RIPE')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(7), qc), 'RIPE')
})

test('QC shift is clamped to one day', () => {
  const qc = qcAt(3, 'RIPE') // expected raw, two stages ahead
  assert.equal(stageFor(DEFAULT_RULES, batch, on(3), qc), 'SEMI_RIPE')
})

test('raw before age 3 is on schedule; semi-ripe at 2 is a fast ripener', () => {
  assert.equal(stageFor(DEFAULT_RULES, batch, on(2), qcAt(2, 'RAW')), null)
  assert.equal(stageFor(DEFAULT_RULES, batch, on(3), qcAt(2, 'RAW')), 'RAW')
  assert.equal(stageFor(DEFAULT_RULES, batch, on(2), qcAt(2, 'SEMI_RIPE')), 'RAW')
})

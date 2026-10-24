import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Needs attention names a failing maintenance step by its label (STEP_LABEL in
// src/pages/NeedsAttention.tsx). Every step the API can record as failing must
// have one, or staff see a raw name like "refund-checks is failing".

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('every step maintenance.js (and the backup heartbeat) can report has a panel label', () => {
  const maintenance = read('../../mango-api/src/maintenance.js')
  const steps = new Set([...maintenance.matchAll(/\bstep\('([a-z-]+)'/g)].map((m) => m[1]))
  steps.add('backup') // ops/backup.sh and ops/backup-heartbeat.sh record it
  assert.ok(steps.size >= 20, `found only ${steps.size} steps: the pattern no longer matches maintenance.js`)
  const page = read('../../src/pages/NeedsAttention.tsx')
  const block = /const STEP_LABEL[^{]*\{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ''
  const labelled = new Set([...block.matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]))
  assert.deepEqual([...steps].filter((s) => !labelled.has(s)).sort(), [])
})

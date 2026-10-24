// Checks every text/background pair in design/tokens.css passes WCAG AA (4.5:1), in light and dark.
import { readFileSync } from 'node:fs'
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const darkAt = css.indexOf('prefers-color-scheme: dark')
const read = (part) => Object.fromEntries([...part.matchAll(/--(color-[a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
const light = read(css.slice(0, darkAt))
const dark = { ...light, ...read(css.slice(darkAt)) }
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const pairs = [
  ['ink', 'bg'], ['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
  ['on-accent', 'accent'], ['accent-strong', 'bg'], ['accent-strong', 'surface'], ['ink', 'accent-soft'],
  ['success', 'surface'], ['success', 'success-soft'], ['warning', 'surface'], ['warning', 'warning-soft'],
  ['error', 'surface'], ['error', 'error-soft'], ['info', 'surface'], ['info', 'info-soft'],
  ['on-disabled', 'disabled'], ['on-staff', 'staff'], ['staff-strong', 'surface'], ['staff-strong', 'bg'],
  ['ink', 'staff-soft'],
]
// Non-text marks (focus ring, empty stars) need 3:1 (WCAG 1.4.11).
const marks = [['focus', 'bg'], ['focus', 'surface'], ['star-empty', 'bg'], ['star-empty', 'surface']]
let bad = 0
for (const [mode, t] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg] of pairs) {
    const r = ratio(t[`color-${fg}`], t[`color-${bg}`])
    if (r < 4.5) bad++
    console.log(`${r < 4.5 ? 'FAIL' : 'ok  '} ${mode.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)}`)
  }
  for (const [fg, bg] of marks) {
    const r = ratio(t[`color-${fg}`], t[`color-${bg}`])
    if (r < 3) bad++
    console.log(`${r < 3 ? 'FAIL' : 'ok  '} ${mode.padEnd(5)} ${fg} on ${bg} (mark, 3:1): ${r.toFixed(2)}`)
  }
}
process.exit(bad ? 1 : 0)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t09-005: Dispose + Revalue (+ record-usage/manual + multi-book run)
// fired zero requests — their Popover triggers never opened the panel. The
// shared Popover is fully controlled and renders the trigger as-is, so every
// trigger must toggle its own open state (the convention in all ~20 other
// call sites). Guard all four asset triggers.
const dir = dirname(fileURLToPath(import.meta.url))
const cases = [
  'DisposeButton.tsx',
  'RemeasureButton.tsx',
  'RunDepreciationButton.tsx',
  'DepreciationInputButton.tsx',
]

for (const file of cases) {
  test(`${file} trigger toggles its popover open`, () => {
    const source = readFileSync(join(dir, file), 'utf8')
    const trigger = source.slice(source.indexOf('trigger={'))
    assert.match(trigger, /onClick=\{[^}]*(setOpen|changeOpen)/)
  })
}

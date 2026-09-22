import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t09-005: Dispose + Revalue (+ record-usage/manual) fired zero requests —
// their Popover triggers never opened the panel. The shared Popover is fully
// controlled and renders the trigger as-is, so every trigger must toggle its
// own open state (the convention in all ~20 other call sites). Guard the
// remaining popover triggers. RunDepreciationButton is deliberately absent:
// it no longer uses a popover — it opens the review/confirm drawer, and the
// fence test below pins that no other UI path posts a run.
const dir = dirname(fileURLToPath(import.meta.url))
const cases = [
  'DisposeButton.tsx',
  'RemeasureButton.tsx',
  'DepreciationInputButton.tsx',
]

for (const file of cases) {
  test(`${file} trigger toggles its popover open`, () => {
    const source = readFileSync(join(dir, file), 'utf8')
    const trigger = source.slice(source.indexOf('trigger={'))
    assert.match(trigger, /onClick=\{[^}]*(setOpen|changeOpen)/)
  })
}

const reversalSource = readFileSync(join(dir, 'ReverseEventButton.tsx'), 'utf8')

test('ReverseEventButton trigger opens its popover', () => {
  const trigger = reversalSource.slice(reversalSource.indexOf('trigger={'))
  assert.match(trigger, /onClick=\{[^}]*show/)
})

test('ReverseEventButton posts the event, date, and reason the engine requires', () => {
  assert.match(reversalSource, /body: JSON\.stringify\(\{ eventId: selected\.id, date, reason: reason\.trim\(\) \}\)/)
})

test('ReverseEventButton reads refusal bodies only after checking the response', () => {
  for (const call of ['/reverse-event`)', '/reverse-event`,']) {
    const at = reversalSource.indexOf(call)
    assert.ok(at > -1, 'both candidate and reversal fetches must exist')
    const after = reversalSource.slice(at)
    const guard = after.indexOf('if (!res.ok)')
    const parse = after.indexOf('res.json()')
    assert.ok(guard > -1 && parse > -1 && guard < parse, 'res.ok must precede res.json()')
  }
})

const buttonSource = readFileSync(join(dir, 'RunDepreciationButton.tsx'), 'utf8')

test('RunDepreciationButton opens the review drawer instead of posting', () => {
  assert.match(buttonSource, /<RunDepreciationDrawer/)
  assert.match(buttonSource, /onClick=\{\(\) => setOpen\(true\)\}/)
  assert.doesNotMatch(buttonSource, /\/api\/assets\/run-depreciation/)
  assert.doesNotMatch(buttonSource, /\/api\/assets\/depreciation-preview/)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('web/lib/confirm.tsx', 'utf8')

test('document Enter handling defers to focused buttons', () => {
  const keyHandler =
    source.match(
      /function onKey\(e: KeyboardEvent\) \{[\s\S]*?\n    \}/,
    )?.[0] ?? ''

  // A focused Cancel button must reach its native click handler before any
  // document-level shortcut can settle the dialog.
  assert.match(
    keyHandler,
    /e\.key === 'Enter' && !\(e\.target instanceof HTMLButtonElement\)\) settle\(true\)/,
  )
  assert.doesNotMatch(keyHandler, /if \(e\.key === 'Enter'\) settle\(true\)/)
})

test('confirmation buttons still settle their explicit choices', () => {
  assert.match(
    source,
    /<Button variant="outline" onClick=\{\(\) => settle\(false\)\}>/,
  )
  assert.match(source, /onClick=\{\(\) => settle\(true\)\}/)
})

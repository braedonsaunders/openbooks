import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./SettingsForm.tsx', import.meta.url), 'utf8')

// F-t01-010: clearing Display name and saving gave zero feedback — Save
// stays enabled, the input carries no invalid state, and the empty value is
// silently rejected server-side. A transient toast alone is not enough: the
// field itself must carry the required error (the parties-display-name
// precedent, F-t02-009), pinned where the tester can still read it.
test('a blank display name pins an inline required error on the field', () => {
  assert.match(
    source,
    /aria-invalid/,
    'the name input must expose its invalid state to assistive tech and styling',
  )
  assert.match(
    source,
    /role="alert"/,
    'the required error must render as a persistent alert, not only a toast',
  )
  assert.match(
    source,
    /validation\.nameRequired/,
    'the inline error must reuse the localized required copy',
  )
  assert.match(
    source,
    /setShowNameError\(true\)|setNameError\(true\)/,
    'a save attempt with a blank name must raise the field error state',
  )
})

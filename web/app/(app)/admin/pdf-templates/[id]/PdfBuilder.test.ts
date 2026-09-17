import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PdfBuilder.tsx', import.meta.url), 'utf8')

test('the grapesjs canvas loads no external CDN stylesheet (CSP)', () => {
  // F-t10-005: grapesjs injects its cssIcons default (font-awesome 4.7.0 on
  // cdnjs) unless disabled, and the app CSP blocks it on every editor load.
  // No template or block uses fa-* classes, so the reference is dead: the
  // builder must pin cssIcons off rather than vendor a stylesheet nothing
  // renders.
  assert.doesNotMatch(
    source,
    /cdnjs|font-awesome|fontawesome/i,
    'the builder must reference no external CDN stylesheet',
  )
  assert.match(
    source,
    /cssIcons:\s*(['"]{2}|undefined)/,
    'grapesjs cssIcons must be explicitly disabled',
  )
})

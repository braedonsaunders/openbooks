import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FormDesigner.tsx', import.meta.url), 'utf8')

/**
 * F-t10-004 — deleting the org-default form fired on one click with no
 * confirmation and left the record type with no default (falling back to
 * the standard layout silently). Deleting the default must confirm first,
 * naming the fallback.
 */
test('deleting the org-default form confirms before the DELETE goes out', () => {
  assert.match(
    source,
    /def\?\.isDefault[\s\S]{0,400}confirm\(/,
    'remove() must ask for confirmation when the form being deleted is the org default',
  )
  assert.match(
    source,
    /deleteDefaultConfirm/,
    'the confirmation names the consequence through a localized string',
  )
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FormDesigner.tsx', import.meta.url), 'utf8')

/**
 * F-t10-001 — saving an existing form PATCHed the COLLECTION url
 * (/api/customization/form-layouts), which only serves GET+POST, so every
 * edit died with a silent 405 (and an empty-body res.json() throw stuck the
 * button on "Saving…" forever). Updates belong on the member route, which
 * implements PATCH (with the isDefault exclusivity transaction).
 */
test('form edits PATCH the member route, never the collection url', () => {
  assert.doesNotMatch(
    source,
    /fetch\('\/api\/customization\/form-layouts',\s*\{\s*method:\s*creating \? 'POST' : 'PATCH'/,
    'PATCH has no collection handler — an edit sent there 405s',
  )
  assert.match(
    source,
    /form-layouts\/\$\{/,
    'edits must address /api/customization/form-layouts/<id>, where PATCH lives',
  )
})

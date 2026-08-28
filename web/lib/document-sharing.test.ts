import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SHARE_PANEL_SOURCE = readFileSync(
  new URL('../app/(app)/documents/SharePanel.tsx', import.meta.url),
  'utf8',
)

test('sharing load fails closed when either endpoint or payload is unavailable', () => {
  const load = SHARE_PANEL_SOURCE.slice(
    SHARE_PANEL_SOURCE.indexOf('async function load()'),
    SHARE_PANEL_SOURCE.indexOf('\n  useEffect(() => {'),
  )

  assert.match(load, /const \[g, p\] = await Promise\.all\(\[fetch\(base\), fetch\('\/api\/file-cabinet\/principals'\)\]\)/)
  assert.match(load, /if \(!g\.ok \|\| !p\.ok\) throw new Error\('SHARING_LOAD_FAILED'\)/)
  assert.match(load, /!Array\.isArray\(grantsPayload\.grants\)/)
  assert.match(load, /!Array\.isArray\(principalsPayload\.users\)/)
  assert.match(load, /!Array\.isArray\(principalsPayload\.roles\)/)
  assert.match(load, /setLoadError\(true\)/)
  assert.doesNotMatch(load, /r\.ok \? r\.json\(\) : \{ grants: \[\] \}/)
})

test('sharing UI distinguishes a load failure from the legitimate empty-grants state', () => {
  assert.match(SHARE_PANEL_SOURCE, /\{loadError \? \(/)
  assert.match(SHARE_PANEL_SOURCE, /<div role="alert"/)
  assert.match(SHARE_PANEL_SOURCE, /tc\('feedback\.loadFailed'\)/)
  assert.match(SHARE_PANEL_SOURCE, /tc\('actions\.retry'\)/)
  assert.match(SHARE_PANEL_SOURCE, /\) : grants == null \? \(/)
  assert.match(SHARE_PANEL_SOURCE, /\) : grants\.length === 0 \? \(/)
  assert.match(SHARE_PANEL_SOURCE, /disabled=\{busy \|\| loadError \|\| grants == null\}/)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const designer = readFileSync(new URL('./FormDesigner.tsx', import.meta.url), 'utf8')
const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const widgets = readFileSync(new URL('../../../../components/viewspec/widgets.tsx', import.meta.url), 'utf8')

/**
 * F-t10-002 — FormDesigner keeps its field state in mount-only useState, and
 * the drawer rendered it with no session key: opening Duplicate after
 * editing the org-default form carried isDefault=true (plus the old
 * name/layout seed) into the create session, so the copy silently stole
 * the org default on save. The drawer must remount per session —
 * edit-<id> vs create-from-<source> — so no session inherits another's
 * checkbox state.
 */
test('form drawer remounts per session so duplicate never inherits edit state', () => {
  assert.match(
    view,
    /formDrawerKey/,
    'the loader must derive a per-session drawer key (form id + duplicate source)',
  )
  assert.match(
    widgets,
    /key=\{[^}]*drawerKey/i,
    'the form-drawer widget must remount FormDesigner when the session key changes',
  )
  assert.match(
    designer,
    /useState\(def\?\.isDefault \?\? false\)/,
    'create sessions (def null) must initialize isDefault false — the remount above is what makes this initializer run per session',
  )
})

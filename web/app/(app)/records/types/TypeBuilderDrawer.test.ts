import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const drawer = readFileSync(new URL('./TypeBuilderDrawer.tsx', import.meta.url), 'utf8')
const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const route = readFileSync(
  new URL('../../../api/records/types/[id]/route.ts', import.meta.url),
  'utf8',
)

test('TypeBuilderDrawer sends the loaded updated_at and never tokenless PATCH', () => {
  assert.match(drawer, /updated_at: string/)
  assert.match(drawer, /expectedUpdatedAt: loadedUpdatedAt\.current/)
  assert.match(drawer, /loadedUpdatedAt\.current = data\.type\.updated_at/)
  assert.match(drawer, /if \(!res\.ok\)/)
  assert.doesNotMatch(drawer, /body: JSON\.stringify\(payload\)/)
  assert.match(view, /updated_at: t\.updated_at/)
})

test('type PATCH refuses a missing token and judges subsidiary_id drop on the locked row', () => {
  assert.match(route, /if \(!isDocumentRevisionToken\(body\.expectedUpdatedAt\)\)/)
  assert.match(route, /typeDeclaresSubsidiary\(locked\.fields, locked\.name\)/)
  assert.doesNotMatch(route, /token \?\? openedRevision/)
  assert.doesNotMatch(route, /expectedRevision = token \?\?/)
  assert.doesNotMatch(route, /typeDeclaresSubsidiary\(type\.fields/)
})

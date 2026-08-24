import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

// tsx compiles neighboring legacy JSX modules with the classic runtime when
// this test starts from the repository root; provide that runtime explicitly.
const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const {
  buildDocumentSaveRequest,
  persistedDocumentRevision,
  readDocumentSaveFailure,
  reconcilePersistedDocumentSnapshot,
  revisionFromSuccessfulDocumentSave,
} = await import('../components/document-drawer.tsx')

const DRAWER_SOURCE = readFileSync(new URL('../components/document-drawer.tsx', import.meta.url), 'utf8')
const OPENED_REVISION = '2026-08-24T12:34:56.123001Z'
const SAVED_REVISION = '2026-08-24T12:34:56.123999Z'

test('the drawer retains the exact persisted revision without wall-clock synthesis', () => {
  assert.equal(persistedDocumentRevision(OPENED_REVISION), OPENED_REVISION)
  for (const invalid of [
    undefined,
    null,
    '',
    '2026-08-24T12:34:56.123Z',
    new Date(OPENED_REVISION),
  ]) {
    assert.throws(() => persistedDocumentRevision(invalid), /DOCUMENT_REVISION_REQUIRED/)
  }
})

test('draft and correction saves forward the persisted revision as the sole token', () => {
  const payload = { memo: 'edited', expectedUpdatedAt: 'payload-must-not-override-persisted-state' }
  const draft = buildDocumentSaveRequest('doc-1', OPENED_REVISION, payload, false)
  assert.equal(draft.path, '/api/documents/doc-1')
  assert.equal(draft.method, 'PATCH')
  assert.equal(draft.body.expectedUpdatedAt, OPENED_REVISION)

  const correction = buildDocumentSaveRequest('doc-1', OPENED_REVISION, payload, true, 'controller reason')
  assert.equal(correction.path, '/api/documents/doc-1/correct')
  assert.equal(correction.method, 'POST')
  assert.equal(correction.body.expectedUpdatedAt, OPENED_REVISION)
  assert.equal(correction.body.amendmentReason, 'controller reason')
})

test('a successful draft save refreshes the next write revision from the persisted response', () => {
  const refreshed = revisionFromSuccessfulDocumentSave({
    doc: { updated_at: SAVED_REVISION },
  })
  assert.equal(refreshed, SAVED_REVISION)
  assert.equal(
    buildDocumentSaveRequest('doc-1', refreshed, { memo: 'second edit' }, false).body.expectedUpdatedAt,
    SAVED_REVISION,
  )
  assert.throws(() => revisionFromSuccessfulDocumentSave({ doc: {} }), /DOCUMENT_REVISION_REQUIRED/)
})

test('a clean refresh rehydrates form data and its exact token as one snapshot', () => {
  const opened = new Set([OPENED_REVISION])
  const current = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'A' } }
  const incoming = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'B' } }
  const refreshed = reconcilePersistedDocumentSnapshot(current, incoming, false, opened)
  assert.deepEqual(refreshed, { snapshot: incoming, rehydrate: true })
  assert.deepEqual(
    buildDocumentSaveRequest('doc-1', refreshed.snapshot.revision, refreshed.snapshot.payload, false).body,
    { memo: 'B', expectedUpdatedAt: SAVED_REVISION },
    'the next save cannot pair stale A form values with the newer B token',
  )
})

test('a dirty refresh retains its opened snapshot so a stale save conflicts', () => {
  const current = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'A' } }
  const incoming = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'external B' } }
  const retained = reconcilePersistedDocumentSnapshot(
    current,
    incoming,
    true,
    new Set([OPENED_REVISION]),
  )
  assert.deepEqual(retained, { snapshot: current, rehydrate: false })
  assert.equal(
    buildDocumentSaveRequest('doc-1', retained.snapshot.revision, { memo: 'local edit' }, false)
      .body.expectedUpdatedAt,
    OPENED_REVISION,
    'the stale editor must send the token it opened, not bless itself with the external token',
  )
})

test('cancel restores the saved baseline across delayed props and adopts an unseen refresh', () => {
  const saved = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'saved B' } }
  const delayed = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'old A' } }
  const retained = reconcilePersistedDocumentSnapshot(
    saved,
    delayed,
    false,
    new Set([OPENED_REVISION, SAVED_REVISION]),
  )
  assert.deepEqual(retained, { snapshot: saved, rehydrate: false })

  const externalRevision = '2026-08-24T12:34:56.124001Z'
  const external = { documentId: 'doc-1', revision: externalRevision, payload: { memo: 'external C' } }
  const adopted = reconcilePersistedDocumentSnapshot(
    saved,
    external,
    false,
    new Set([OPENED_REVISION, SAVED_REVISION]),
  )
  assert.deepEqual(adopted, { snapshot: external, rehydrate: true })
})

test('a stale save surfaces the server conflict instead of manufacturing a new token', async () => {
  const failure = await readDocumentSaveFailure(
    {
      status: 409,
      json: async () => ({ error: 'this document changed after you opened it' }),
    },
    'fallback',
  )
  assert.deepEqual(failure, {
    message: 'this document changed after you opened it',
    isConflict: true,
  })

  const save = DRAWER_SOURCE.slice(
    DRAWER_SOURCE.indexOf('async function save()'),
    DRAWER_SOURCE.indexOf('function cancel()'),
  )
  assert.match(save, /buildDocumentSaveRequest\([\s\S]*?documentRevision/)
  assert.match(
    save,
    /savedRevision = revisionFromSuccessfulDocumentSave\(data\)[\s\S]*?setDocumentRevision\(savedRevision\)/,
  )
  assert.match(save, /readDocumentSaveFailure\([\s\S]*?toast\.error\(failure\.message\)/)
  assert.doesNotMatch(save, /Date\.now|new Date\(/)
  assert.match(
    DRAWER_SOURCE,
    /reconcilePersistedDocumentSnapshot\([\s\S]*?resetForm\(decision\.snapshot\.payload\)/,
  )
  assert.match(
    DRAWER_SOURCE,
    /persistedBaseline\.current = \{[\s\S]*?payload: data[\s\S]*?resetForm\(data\)/,
  )
  assert.match(
    DRAWER_SOURCE,
    /function cancel\(\)[\s\S]*?reconcilePersistedDocumentSnapshot\([\s\S]*?resetForm\(decision\.snapshot\.payload\)/,
  )
})

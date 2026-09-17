import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./CloseSetupWorkspace.tsx', import.meta.url), 'utf8')

test('period generation failure keeps the drawer open and renders the server reason', () => {
  // F-t06-007: regenerating a year with ledger activity answers 422 with a
  // specific reason ("<period> has ledger activity and its dates cannot be
  // regenerated"). post() rethrows it as the Error message, so the dialog
  // must surface that message — not only the generic actionFailed toast.
  assert.match(
    source,
    /catch \(error\) \{ setGenerateError\(error instanceof Error && error\.message \? error\.message : t\("errors\.actionFailed"\)\)/,
    'the generate catch must persist the server failure message into dialog state',
  )
  assert.match(
    source,
    /\{generateError \? <p role="alert"[^>]*>\{generateError\}<\/p> : null\}/,
    'the generate drawer must render the persisted failure as an alert',
  )
})

test('period drawer surfaces pending reopen requests for its period and book', () => {
  // F-t06-012: submitted requests were invisible in the requester's drawer,
  // so testers re-submitted blindly (two identical outstanding requests).
  // The drawer derives pending rows from the already-loaded reopen list.
  assert.match(
    source,
    /pendingReopen/,
    'PeriodDrawer must surface the pending reopen requests for its period+book instead of only a blank request form',
  )
  assert.match(
    source,
    /reopenStates/,
    'pending rows carry their workflow status like the setup-page list does',
  )
})

test('period generation navigates away only on success', () => {
  // The drawer must stay mounted on failure so the alert above is readable;
  // the only generate-path navigation is the success redirect.
  const navigations = source.match(/router\.push\(\(mergeHref\(closeHref, \{\}, \{ fy: year \}\)\)\)/g) ?? []
  assert.equal(navigations.length, 1, 'exactly one post-generate navigation (the success path)')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { lifecycleActionsForStatus } from './actions'

/**
 * F2: attaching a candidate to a DRAFT requisition refused with "open it",
 * but the drawer offered no Open action — the persona had to hand-PATCH the
 * API. The drawer now carries the lifecycle controls the requisition's
 * status allows, through the shared action-island composition, gated by the
 * same hrm.recruiting.manage grant the PATCH endpoint enforces.
 */

const actions = readFileSync(new URL('./actions.tsx', import.meta.url), 'utf8')
const sections = readFileSync(new URL('./sections.tsx', import.meta.url), 'utf8')
const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('a draft requisition shows Open; after it opens, Hold and Cancel show', () => {
  assert.deepEqual(lifecycleActionsForStatus('draft'), ['open'], 'a draft offers only Open')
  assert.deepEqual(
    lifecycleActionsForStatus('open'),
    ['hold', 'cancel'],
    'an open requisition offers Hold and Cancel',
  )
  assert.deepEqual(lifecycleActionsForStatus('on_hold'), ['resume'], 'an on-hold requisition offers Resume')
  assert.deepEqual(lifecycleActionsForStatus('filled'), [], 'a filled requisition offers nothing')
  assert.deepEqual(lifecycleActionsForStatus('cancelled'), [], 'a cancelled requisition offers nothing')
})

test('the matrix mirrors the service transitions, never invents its own', () => {
  assert.match(
    actions,
    /mirrors transitionRequisition\/openRequisition/,
    'the matrix must stay pinned to the engine transitions it mirrors',
  )
  assert.ok(!actions.includes("action === 'fill'"), 'the fill rides hire, never the requisition endpoint')
})

test('the drawer renders the lifecycle island behind the manage grant', () => {
  assert.match(sections, /<RequisitionLifecycleIsland/, 'the requisition body mounts the lifecycle island')
  assert.match(
    sections,
    /canManage=\{detail\.lifecycle\.canManage\}/,
    'the island renders only for the manage grant the API enforces',
  )
  assert.match(view, /can\(authz, 'hrm\.recruiting\.manage'\)/, 'the grant resolved is the manage one')
  assert.match(view, /recruiting\.lifecycle\.open/, 'Open resolves through the locale, never a hardcoded verb')
  assert.match(view, /recruiting\.lifecycle\.cancel/, 'Cancel resolves through the locale, never a hardcoded verb')
})

test('reason prompts ride promptDialog and refusals pin in the drawer', () => {
  assert.match(actions, /promptDialog\(\{[^}]*reason/, 'hold/resume/cancel prompt for the reason the API requires')
  assert.match(actions, /readApiErrorMessage\(res, labels\.failed\)/, 'the API refusal renders, never swallowed')
  assert.match(actions, /role="alert"/, 'the pinned refusal is an accessible alert')
  assert.match(
    actions,
    /`\/api\/hrm\/recruiting\/requisitions\/\$\{requisitionId\}`/,
    'the island PATCHes the same route API clients use',
  )
  assert.ok(!/toast\./.test(actions.split('RequisitionLifecycleIsland')[1]!.split('/** Move')[0]!),
    'lifecycle refusals pin in the drawer, never a transient toast',
  )
})

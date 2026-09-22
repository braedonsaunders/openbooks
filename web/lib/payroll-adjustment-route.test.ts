import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync('web/app/api/payroll/runs/[id]/route.ts', 'utf8')
const wizard = readFileSync('web/app/(app)/payroll/runs/[id]/RunWizard.tsx', 'utf8')

test('every pay-run adjustment mutation uses one permission-gated engine boundary', () => {
  const permission = route.indexOf("guardFeaturePermission('payroll.run', 'payroll')")
  const body = route.indexOf('parseJsonBody(req, jsonObject)')
  assert.ok(permission >= 0 && permission < body, 'payroll.run is enforced before action dispatch')
  assert.doesNotMatch(route, /req\.json\(/)
  assert.match(route, /mutatePayRunAdjustment/)
  assert.doesNotMatch(route, /insert into pay_run_adjustments/)
  assert.doesNotMatch(route, /delete from pay_run_adjustments/)
  for (const action of ['add-adjustment', 'delete-adjustment', 'exclude-employee', 'include-employee']) {
    assert.match(route, new RegExp(action))
  }
  assert.match(wizard, /canAdjust=\{props\.canRun && docDraft && run\.run_status !== 'committed'\}/)
})

// Double-submitted adjustment writes must not duplicate earnings: the wizard
// guards the click and the boundary guards the retry, on the same
// key-becomes-row-id contract document creates use.

test('adjust() serializes re-entry and always releases the guard', () => {
  // setBusy is state (async): a double-click lands twice before the buttons
  // disable, so the ref closes the gap — and try/finally releases it, so a
  // failed request never wedges the wizard.
  assert.match(wizard, /const adjustInflight = useRef\(false\)/)
  assert.match(wizard, /if \(adjustInflight\.current\) return false/)
  assert.match(wizard, /adjustInflight\.current = false/)
})

test('the form session key travels as the Idempotency-Key header, never a stored field', () => {
  assert.match(wizard, /const \{ idempotencyKey, \.\.\.action \} = body/)
  assert.match(wizard, /'Idempotency-Key': idempotencyKey/)
  assert.match(route, /req\.headers\.get\('Idempotency-Key'\)/)
})

test('both drawers disable while busy and name progress, with the key surviving failure', () => {
  // busy reaches both drawers through ReviewStep.
  assert.match(wizard, /busy=\{busy\}\n\s+onAdjust=\{adjust\}/)
  assert.match(wizard, /<StubDrawer[\s\S]{0,600}?busy=\{busy\}/)
  assert.match(wizard, /<BulkEditDrawer[\s\S]{0,300}?busy=\{busy\}/)
  // Both submit buttons disable on validity AND busyness, with a pending label.
  assert.match(wizard, /disabled=\{!valid \|\| busy\}/)
  assert.match(wizard, /disabled=\{!adjComponent [\s\S]{0,80}?\|\| busy\}/)
  assert.match(wizard, /busy \? tCommon\('actions\.saving'\)/)
  // One stable key per drawer session; the stub form rotates it after a
  // SUCCESSFUL add only, so a failed attempt keeps its key and the retry
  // replays instead of duplicating.
  assert.match(wizard, /const \[requestKey\] = useState\(\(\) => crypto\.randomUUID\(\)\)/)
  assert.match(wizard, /const \[requestKey, setRequestKey\] = useState\(\(\) => crypto\.randomUUID\(\)\)/)
  assert.match(wizard, /\.then\(\(added\) => \{\s+if \(!added\) return/)
  assert.match(wizard, /setRequestKey\(crypto\.randomUUID\(\)\)/)
})

test('adjustment adds accept an idempotency key: malformed 400s, conflicts 409', () => {
  assert.match(route, /payRunBulkAdjustmentId/)
  assert.match(route, /idempotencyKey: requestIds\[index\]!/)
  assert.match(route, /idempotencyKey: adjustmentKey/)
  const bad = route.match(/invalid_idempotency_key' \}, \{ status: 400 \}\)/g) ?? []
  assert.ok(bad.length >= 2, 'both add paths refuse a malformed key before any write')
  const conflict = route.match(/invalid_idempotency_key' \}, \{ status: 409 \}\)/g) ?? []
  assert.ok(conflict.length >= 2, 'both add paths map a key conflict to 409, never a second row')
  assert.match(route, /PayRunAdjustmentIdempotencyConflict/)
})

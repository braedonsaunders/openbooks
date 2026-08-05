import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync('web/app/api/payroll/runs/[id]/route.ts', 'utf8')
const wizard = readFileSync('web/app/(app)/payroll/runs/[id]/RunWizard.tsx', 'utf8')

test('every pay-run adjustment mutation uses one permission-gated engine boundary', () => {
  const permission = route.indexOf("guardFeaturePermission('payroll.run', 'payroll')")
  const body = route.indexOf('await req.json()')
  assert.ok(permission >= 0 && permission < body, 'payroll.run is enforced before action dispatch')
  assert.match(route, /mutatePayRunAdjustment/)
  assert.doesNotMatch(route, /insert into pay_run_adjustments/)
  assert.doesNotMatch(route, /delete from pay_run_adjustments/)
  for (const action of ['add-adjustment', 'delete-adjustment', 'exclude-employee', 'include-employee']) {
    assert.match(route, new RegExp(action))
  }
  assert.match(wizard, /canAdjust=\{props\.canRun && docDraft && run\.run_status !== 'committed'\}/)
})

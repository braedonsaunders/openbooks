import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync('web/app/api/payroll/runs/[id]/bank-file/route.ts', 'utf8')
const wizard = readFileSync('web/app/(app)/payroll/runs/[id]/RunWizard.tsx', 'utf8')

test('payroll bank files require run authority and cannot be cached', () => {
  assert.match(route, /guardFeaturePermission\('payroll\.run', 'payroll'\)/)
  assert.match(route, /'Cache-Control': 'no-store'/)
  assert.match(route, /status: 409/)
  assert.doesNotMatch(route, /buildPayRunBankFile/)
  assert.doesNotMatch(route, /Content-Disposition/)
  assert.doesNotMatch(wizard, /\/bank-file/)
  assert.doesNotMatch(wizard, /createBankFile/)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BUILTIN_PROJECT_TYPES } from '@openbooks/schema'
import { assertValidProjectFinancialProfile } from './project-financial-profile-versions.ts'

test('every built-in project type declares an explicit billing procedure', () => {
  assert.ok(BUILTIN_PROJECT_TYPES.length >= 5)
  for (const type of BUILTIN_PROJECT_TYPES) {
    assert.ok(['standard', 'application_for_payment'].includes(type.invoicingProfile.billingProcedure))
  }
})

test('schedule-of-values billing is a fixed-price project procedure', () => {
  const type = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === 'schedule_of_values')
  if (!type) throw new Error('schedule_of_values built-in is missing')
  assert.equal(type.billingMethod, 'fixed_price')
  assert.equal(type.invoicingProfile.billingProcedure, 'application_for_payment')
  assert.deepEqual(type.invoicingProfile.allowedBases, ['draw_amount'])
})

test('fixed-price time is cost evidence unless an explicit work basis bills it', () => {
  const type = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === 'fixed_price')
  if (!type) throw new Error('fixed_price built-in is missing')
  assert.equal(type.financialProfile.totalPrice.method, 'contract_field')
  assert.equal(type.invoicingProfile.defaultBasis, 'milestone')
  assert.equal(type.invoicingProfile.lineBuilder, 'milestone')

  const billing = readFileSync('web/lib/billing.ts', 'utf8')
  assert.match(
    billing,
    /const billsActualWork = req\.basis === 'field_ticket' \|\| req\.basis === 'time_selection' \|\| req\.basis === 'date_range'/,
  )
  assert.match(
    billing,
    /invoicing\.lineBuilder === 'milestone' && !billsActualWork/,
  )
})

test('project financial policy is effective-dated, immutable, and tenant isolated', () => {
  const baseline = readFileSync(
    'schema/migrations/generated/0001_baseline.sql',
    'utf8',
  )
  assert.match(baseline, /project financial profile effective ranges cannot overlap/)
  assert.match(baseline, /published project financial profile versions are immutable/)
  assert.match(baseline, /ALTER TABLE ONLY public\.project_financial_profile_versions FORCE ROW LEVEL SECURITY/)
  assert.match(baseline, /CREATE POLICY org_isolation ON public\.project_financial_profile_versions/)
  assert.match(baseline, /openbooks\.correct_project_profile/)
  assert.match(baseline, /may change only policy JSON and requires a reason/)
  const projectTypesTable = baseline.match(
    /CREATE TABLE public\.project_types \(([\s\S]*?)\n\);/,
  )?.[1]
  assert.ok(projectTypesTable)
  assert.doesNotMatch(projectTypesTable, /financial_profile/)

  const service = readFileSync(
    'engine/src/project-financial-profile-versions.ts',
    'utf8',
  )
  assert.match(service, /controlled_historical_correction/)
  assert.match(service, /project financial profile changed after the correction was planned/)

  const resolver = readFileSync('engine/src/project-type.ts', 'utf8')
  assert.match(resolver, /v\.effective_from <= \$\{effectiveAsOf\}/)
  assert.match(resolver, /v\.effective_to is null or v\.effective_to >= \$\{effectiveAsOf\}/)
})

test('project cost and selling-value evidence preserve canonical document direction', () => {
  const financials = readFileSync('engine/src/project-financials.ts', 'utf8')
  assert.match(
    financials,
    /d\.kind = 'vendor_credit'\s+then -dl\.amount else dl\.amount end/,
  )
  assert.doesNotMatch(
    financials,
    /d\.kind in \('sales_order','purchase_order'\) then -dl\.amount/,
  )
  assert.match(
    financials,
    /d\.kind = 'project_charge'\s+then coalesce\(dl\.cost_amount, dl\.amount\)/,
  )
  assert.match(
    financials,
    /profile\.committedCost\.statuses \?\? \['approved'\]/,
  )
  assert.match(
    financials,
    /d\.status in \(\$\{kindList\(committedStatuses/,
  )
  assert.match(
    financials,
    /when dl\.bill_amount is not null/,
  )
  assert.match(
    financials,
    /sum\(round\(te\.hours \* coalesce\(te\.bill_rate, 0\), 4\)\)/,
  )
  assert.match(
    financials,
    /round\([\s\S]*dl\.markup_percent \/ 100[\s\S]*4[\s\S]*\)/,
  )

  const billing = readFileSync('web/lib/billing.ts', 'utf8')
  assert.match(
    billing,
    /d\.kind = 'vendor_credit' then -dl\.amount else dl\.amount end/,
  )
  assert.doesNotMatch(
    billing,
    /d\.kind in \('sales_order','purchase_order'\) then -dl\.amount/,
  )
})

test('tenant project forecasts may explicitly include source rejected documents', () => {
  const builtIn = BUILTIN_PROJECT_TYPES.find(
    (candidate) => candidate.key === 'time_and_materials',
  )
  if (!builtIn) throw new Error('time_and_materials built-in is missing')
  const profile = structuredClone(builtIn.financialProfile)
  profile.committedCost.statuses = [
    'pending_approval',
    'approved',
    'rejected',
  ]
  profile.billableValue.costSourceStatuses = [
    'pending_approval',
    'approved',
    'posted',
    'rejected',
  ]
  assert.doesNotThrow(() => assertValidProjectFinancialProfile(profile))

  const invalid = structuredClone(profile) as unknown as {
    committedCost: { statuses: string[] }
  }
  invalid.committedCost.statuses = ['voided']
  assert.throws(
    () => assertValidProjectFinancialProfile(invalid),
    /committedCost\.statuses contains an unsupported lifecycle/,
  )
})

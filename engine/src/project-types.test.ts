import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BUILTIN_PROJECT_TYPES } from '@openbooks/schema'

test('every built-in project type declares an explicit billing procedure', () => {
  assert.ok(BUILTIN_PROJECT_TYPES.length >= 5)
  for (const type of BUILTIN_PROJECT_TYPES) {
    assert.ok(['standard', 'application_for_payment'].includes(type.invoicingProfile.billingProcedure ?? ''))
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
  const migration = readFileSync(
    'schema/migrations/generated/0079_project_financial_profile_versions.sql',
    'utf8',
  )
  assert.match(migration, /project financial profile effective ranges cannot overlap/)
  assert.match(migration, /published project financial profile versions are immutable/)
  assert.match(migration, /project_types\.financial_profile is a seed value/)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/)
  assert.match(migration, /CREATE POLICY org_isolation ON project_financial_profile_versions/)

  const resolver = readFileSync('web/lib/project-type.ts', 'utf8')
  assert.match(resolver, /v\.effective_from <= \$\{asOf\}/)
  assert.match(resolver, /v\.effective_to is null or v\.effective_to >= \$\{asOf\}/)
})

test('project cost and selling-value evidence preserve canonical document direction', () => {
  const financials = readFileSync('web/lib/project-financials.ts', 'utf8')
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
    /d\.status = 'approved'[\s\S]*d\.kind = 'project_charge'/,
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

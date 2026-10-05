import assert from 'node:assert/strict'
import test from 'node:test'

// Units are hours or a quantity; only hours lines feed an hours basis. The
// pay-components block of validateEntityIntegrity (web/lib/setup/write.ts)
// refuses anything outside the vocabulary and the per-hour/quantity
// contradiction — on create and on edit alike, naming the remedy rather
// than surfacing a constraint name. The create path must never touch
// storage, so the stub throws on any query. Only server-only is stubbed.
const { validateEntityIntegrity } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

const ORG = '019f5ea3-44c5-72c0-ad3b-ef34c19c8763'
const COMPONENTS = SETUP_ENTITY_BY_KEY.get('pay-components')!

function noStorage() {
  return {
    execute: () => {
      throw new Error('create-path unit validation must not query storage')
    },
  } as never
}

function editStorage(current: Record<string, unknown>) {
  return {
    execute: () => ({ rows: [current] }),
  } as never
}

test('a quantity fixed-amount component passes integrity', async () => {
  assert.equal(
    await validateEntityIntegrity(COMPONENTS, {
      code: 'TRIPS',
      name: 'Trip allowance',
      kind: 'earning',
      country: 'CA',
      basis: 'fixed_amount',
      unitOfMeasure: 'quantity',
    }, ORG, undefined, noStorage()),
    null,
  )
})

test('an omitted unit reads as hours and passes', async () => {
  assert.equal(
    await validateEntityIntegrity(COMPONENTS, {
      code: 'WAGE', name: 'Wages', kind: 'earning', country: 'CA',
    }, ORG, undefined, noStorage()),
    null,
  )
})

test('a unit outside hours/quantity is refused by name', async () => {
  const problem = await validateEntityIntegrity(COMPONENTS, {
    code: 'X', name: 'X', kind: 'earning', country: 'CA', unitOfMeasure: 'bushels',
  }, ORG, undefined, noStorage())
  assert.match(problem ?? '', /Choose hours or quantity as the component unit of measure/)
})

test('a per-hour quantity component is refused by name, naming the remedy', async () => {
  const problem = await validateEntityIntegrity(COMPONENTS, {
    code: 'BAD', name: 'Bad per-hour', kind: 'earning', country: 'CA',
    basis: 'per_hour', unitOfMeasure: 'quantity',
  }, ORG, undefined, noStorage())
  assert.match(problem ?? '', /always use hours as the unit of measure/)
  assert.match(problem ?? '', /fixed-amount basis for quantity units/)
})

test('switching a per-hour component to quantity on edit is refused', async () => {
  const problem = await validateEntityIntegrity(COMPONENTS, {
    code: 'PREM', name: 'Premium', unitOfMeasure: 'quantity',
  }, ORG, 'row-id', editStorage({
    country: 'CA', tax_treatment: 'none', kind: 'earning', non_periodic: false,
    payment_kind: 'cash', non_cash_account_id: null, system_key: null,
    basis: 'per_hour', unit_of_measure: 'hours',
    supplemental_wage_category: null, statutory_reporting_category: null,
    statutory_exemption_category: null,
  }))
  assert.match(problem ?? '', /always use hours as the unit of measure/)
})

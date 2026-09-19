import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// With the storage layer constraining only the treatment SHAPE (migration
// 0187), the pack declaration is the authority on which treatments exist —
// asked here, at the API boundary, for creates and edits alike. The refusal
// names the treatments the scope declares rather than surfacing a
// constraint name. The create path must never touch storage, so the stub
// throws on any query. Only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { validateEntityIntegrity } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

const ORG = '019f5ea3-44c5-72c0-ad3b-ef34c19c8763'
const COMPONENTS = SETUP_ENTITY_BY_KEY.get('pay-components')!

function noStorage() {
  return {
    execute: () => {
      throw new Error('create-path treatment validation must not query storage')
    },
  } as never
}

test('an AU salary-sacrifice component passes integrity', async () => {
  assert.equal(
    await validateEntityIntegrity(COMPONENTS, {
      code: 'SAL-SAC',
      name: 'Salary sacrifice',
      kind: 'deduction',
      country: 'AU',
      taxTreatment: 'salary_sacrifice',
    }, ORG, undefined, noStorage()),
    null,
  )
})

test('a Canadian factor on an AU component is refused by name, naming the declared treatments', async () => {
  const problem = await validateEntityIntegrity(COMPONENTS, {
    code: 'RPP',
    name: 'Pension',
    kind: 'deduction',
    country: 'AU',
    taxTreatment: 'pension_f',
  }, ORG, undefined, noStorage())
  assert.match(problem ?? '', /not declared by the Australia payroll pack/)
  assert.match(problem ?? '', /"salary_sacrifice"/)
})

test('an undeclared treatment on a pack with no vocabulary says so', async () => {
  const problem = await validateEntityIntegrity(COMPONENTS, {
    code: 'X',
    name: 'X',
    kind: 'deduction',
    country: 'BR',
    taxTreatment: 'pension_f',
  }, ORG, undefined, noStorage())
  assert.match(problem ?? '', /transcribes no pre-tax treatment/)
})

test('after-tax and omitted treatments always pass', async () => {
  assert.equal(
    await validateEntityIntegrity(COMPONENTS, {
      code: 'GARN', name: 'Garnishment', kind: 'deduction', country: 'AU', taxTreatment: 'none',
    }, ORG, undefined, noStorage()),
    null,
  )
  assert.equal(
    await validateEntityIntegrity(COMPONENTS, {
      code: 'EARN', name: 'Earnings', kind: 'earning', country: 'AU',
    }, ORG, undefined, noStorage()),
    null,
  )
})

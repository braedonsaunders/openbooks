import assert from 'node:assert/strict'
import test from 'node:test'

// The overlap hook is pure over the executor: stubbed rows drive every
// branch without a database.
const { validateDepartmentExpenseWrite } = await import('./workforce-validation.ts')

type Row = Record<string, string | null>

/** Canned row-sets in call order: the current-row read, then the clash read. */
function executorFor(steps: { rows: unknown[] }[]) {
  const calls: unknown[] = []
  return {
    calls,
    execute: async (query: unknown) => {
      calls.push(query)
      return steps[Math.min(calls.length - 1, steps.length - 1)]!
    },
  }
}

const MAPPING = {
  payComponentId: '11111111-1111-1111-1111-111111111111',
  departmentId: '22222222-2222-2222-2222-222222222222',
  effectiveFrom: '2026-01-01',
}

test('an overlapping active window refuses with the remedy', async () => {
  const executor = executorFor([{ rows: [{ id: 'existing' }] }])
  const problem = await validateDepartmentExpenseWrite({
    entity: { key: 'pay-component-department-expenses' } as never,
    body: MAPPING,
    orgId: 'org',
    rowId: undefined,
    executor: executor as never,
  })
  assert.match(problem ?? '', /already have an active expense mapping/)
  assert.match(problem ?? '', /close the existing window first/)
})

test('a disjoint window saves', async () => {
  const executor = executorFor([{ rows: [] }])
  const problem = await validateDepartmentExpenseWrite({
    entity: { key: 'pay-component-department-expenses' } as never,
    body: { ...MAPPING, effectiveFrom: '2027-01-01' },
    orgId: 'org',
    rowId: undefined,
    executor: executor as never,
  })
  assert.equal(problem, null)
})

test('editing the same row does not clash with itself', async () => {
  const current: Row = {
    pay_component_id: MAPPING.payComponentId,
    department_id: MAPPING.departmentId,
    effective_from: '2026-01-01',
    effective_to: null,
  }
  const executor = executorFor([{ rows: [current] }, { rows: [] }])
  const problem = await validateDepartmentExpenseWrite({
    entity: { key: 'pay-component-department-expenses' } as never,
    body: { effectiveTo: '2026-12-31' },
    orgId: 'org',
    rowId: 'self',
    executor: executor as never,
  })
  assert.equal(problem, null)
  assert.equal(executor.calls.length, 2)
})

test('editing a deleted row refuses by name', async () => {
  const executor = executorFor([{ rows: [] }])
  const problem = await validateDepartmentExpenseWrite({
    entity: { key: 'pay-component-department-expenses' } as never,
    body: { effectiveTo: '2026-12-31' },
    orgId: 'org',
    rowId: 'gone',
    executor: executor as never,
  })
  assert.match(problem ?? '', /no longer exists/)
})

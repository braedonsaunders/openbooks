import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./budget-mutations.ts', import.meta.url), 'utf8')
const importRoute = readFileSync(new URL('../app/api/budgets/[id]/import/route.ts', import.meta.url), 'utf8')

test('budget cell upserts pin the known tenant on the budget_lines_cell conflict write', () => {
  assert.match(
    source,
    /insert into budget_lines[\s\S]*?on conflict on constraint budget_lines_cell do update set[\s\S]*?where budget_lines\.org_id = \$\{input\.orgId\}/,
  )
})

test('budget import upserts pin the known tenant on the budget_lines_cell conflict write', () => {
  assert.match(
    importRoute,
    /insert into budget_lines[\s\S]*?on conflict on constraint budget_lines_cell do update set[\s\S]*?where budget_lines\.org_id = \$\{user\.orgId\}/,
  )
})

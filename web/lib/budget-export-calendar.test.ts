import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/budgets/[id]/export/route.ts', import.meta.url), 'utf8')
const office = readFileSync(new URL('../../packages/office/src/index.ts', import.meta.url), 'utf8')

test('budget xlsx stamps workbook created/modified from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?reportResultToXlsx\(result, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
  assert.match(
    office,
    /const now = opts\.generatedAt \?\? new Date\(\)[\s\S]*?wb\.created = now[\s\S]*?wb\.modified = now/,
  )
})

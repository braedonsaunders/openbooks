import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/data/export/route.ts', import.meta.url), 'utf8')

test('generic data-export xlsx stamps workbook created/modified from the org business day', () => {
  const helper = readFileSync(new URL('./data-io/serialize.ts', import.meta.url), 'utf8')
  assert.match(
    route,
    /const stamp = await businessToday\(authz\.user\.orgId\)[\s\S]*?toXlsx\(title, cols, rows, new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
  assert.match(
    helper,
    /export function toXlsx\([\s\S]*?generatedAt\?: Date[\s\S]*?return reportResultToXlsx\(buildRunResult\(title, columns, rows\), \{ reportName: title, generatedAt \}\)/,
  )
})

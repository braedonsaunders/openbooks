import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/tax/filings/[id]/export/route.ts', import.meta.url), 'utf8')

test('tax-filing PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('tax-filing xlsx stamps workbook created/modified from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToXlsx\(data, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

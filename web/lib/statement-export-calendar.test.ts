import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/reports/statement/[kind]/export/route.ts', import.meta.url), 'utf8')

test('statement PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('statement view PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /renderStatementViewPdf\(view, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

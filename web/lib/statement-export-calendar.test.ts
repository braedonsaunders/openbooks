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

test('statement emitData xlsx stamps workbook created/modified from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToXlsx\(data, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('statement view xlsx stamps workbook created/modified from the org business day', () => {
  const office = readFileSync(new URL('../../packages/office/src/index.ts', import.meta.url), 'utf8')
  assert.match(
    route,
    /statementViewToXlsx\(view, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
  assert.match(
    office,
    /export async function statementSheetToXlsx\([\s\S]*?const now = opts\.generatedAt \?\? new Date\(\)[\s\S]*?wb\.created = now[\s\S]*?wb\.modified = now/,
  )
})

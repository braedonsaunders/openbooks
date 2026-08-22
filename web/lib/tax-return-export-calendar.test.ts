import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/tax/returns/[code]/export/route.ts', import.meta.url), 'utf8')

test('tax-return PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('tax-return xlsx stamps workbook created/modified from the org business day', () => {
  const helper = readFileSync(new URL('./report-pdf.ts', import.meta.url), 'utf8')
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToXlsx\(data, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
  assert.match(
    helper,
    /export async function exportDataToXlsx\([\s\S]*?generatedAt\?: Date[\s\S]*?return reportResultToXlsx\(exportDataToRunResult\(data\), opts\)/,
  )
})

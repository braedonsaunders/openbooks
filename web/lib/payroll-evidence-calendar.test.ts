import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./payroll-evidence.ts', import.meta.url), 'utf8')

test('payroll-evidence PDFs stamp the footer from the org business day', () => {
  assert.match(
    source,
    /const stamp = await businessToday\(orgId\)[\s\S]*?const generatedAt = new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
  assert.match(
    source,
    /exportDataToPdf\(data, branding, page, \{ showSummary, generatedAt \}\)/,
  )
  assert.match(
    source,
    /exportDataToPdf\(\s*await glPreviewExportData\([\s\S]*?\{ showSummary: true, generatedAt \}/,
  )
})

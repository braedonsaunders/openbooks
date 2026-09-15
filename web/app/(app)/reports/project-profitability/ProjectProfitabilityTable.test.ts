import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ProjectProfitabilityTable.tsx', import.meta.url), 'utf8')
const exportSource = readFileSync(new URL('../../../../lib/report-pdf.ts', import.meta.url), 'utf8')

test('project profitability display scales decimalRatio margins through the shared helper', () => {
  assert.match(
    source,
    /format\.number\(decimalToNumber\(marginRatioToPercent\(String\(value\)\)\)\s*\/\s*100\s*,\s*\{\s*style:\s*'percent'/,
    'decimalRatio returns 0.2500 for a 25% margin; the table scales it once via marginRatioToPercent like variance_pct',
  )
})

test('project profitability display and export share one margin scaling', () => {
  assert.match(
    source,
    /marginRatioToPercent/,
    'the table must scale margins through marginRatioToPercent, not inline math',
  )
  assert.match(
    exportSource,
    /marginRatioToPercent/,
    'the CSV/XLSX/PDF export must scale margins through the same marginRatioToPercent helper',
  )
  assert.doesNotMatch(
    source,
    /Number\(value\)\s*\/\s*10000/,
    'decimalRatio returns 0.2500 for a 25% margin; dividing it again would display 0.0%',
  )
})

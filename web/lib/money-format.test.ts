import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMoneyFormatter } from './money-format.ts'
import { decimalAdd, decimalNeg, decimalSum } from './statement-format.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('locale controls separators and currency placement without changing currency', () => {
  const en = createMoneyFormatter('en', 'CAD').money(1234.56)
  const fr = createMoneyFormatter('fr', 'CAD').money(1234.56)
  const de = createMoneyFormatter('de', 'CAD').money(1234.56)
  const pt = createMoneyFormatter('pt-BR', 'CAD').money(1234.56)

  assert.equal(en, 'CA$1,234.56')
  assert.match(fr, /^1[\s\u202f]234,56[\s\u00a0]\$CA$/)
  assert.equal(de, '1.234,56\u00a0CA$')
  assert.equal(pt, 'CA$\u00a01.234,56')
})

test('Intl currency metadata supplies zero, two, three, and four minor units', () => {
  assert.equal(createMoneyFormatter('ja-JP', 'JPY').money(1234.56), '￥1,235')
  assert.equal(createMoneyFormatter('ko-KR', 'KRW').money(1234.56), '₩1,235')
  assert.equal(createMoneyFormatter('zh-CN', 'CNY').money(1234.56), '¥1,234.56')
  assert.match(createMoneyFormatter('ar-KW', 'KWD').money(1.2345), /١٫٢٣٥/)
  assert.equal(createMoneyFormatter('en', 'CLF').money(1.23456), 'CLF\u00a01.2346')
})

test('locale-specific digit and grouping systems are preserved', () => {
  assert.equal(createMoneyFormatter('hi-IN', 'INR').money(1234567.89), '₹12,34,567.89')
  assert.match(createMoneyFormatter('bn-BD', 'BDT').money(1234.5), /১,২৩৪\.৫০/)
})

test('compact notation is localized instead of hard-coded to K/M/B', () => {
  assert.equal(createMoneyFormatter('en', 'USD').moneyCompact(1200000), '$1.2M')
  assert.equal(createMoneyFormatter('ja', 'JPY').moneyCompact(1200000), '￥120万')
})

test('formatting supports statement accounting signs and per-value currency overrides', () => {
  const format = createMoneyFormatter('en-US', 'USD')
  assert.equal(format.money(-1234.5, { accounting: true }), '($1,234.50)')
  assert.equal(format.money(1234.5, { currency: 'EUR' }), '€1,234.50')
  assert.equal(format.money(1234.5, { currency: 'CAD', currencyDisplay: 'code' }), 'CAD\u00a01,234.50')
})

test('invalid values and malformed currency codes never silently become dollars', () => {
  const format = createMoneyFormatter('en', 'CAD')
  assert.equal(format.money(null), '')
  assert.equal(format.money('not-a-number'), 'not-a-number')
  assert.equal(format.money(12.5, { currency: 'invalid' }), '12.5 INVALID')
})

test('decimal strings never cross the binary floating-point boundary', () => {
  const format = createMoneyFormatter('en-US', 'USD')
  assert.equal(
    format.money('9007199254740993.1234', { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    '$9,007,199,254,740,993.1234',
  )
  assert.equal(format.money('-0.0000'), '$0.00')
})

test('repository money formatters never receive Number-coerced exact decimals', () => {
  const coercion = /\b(?:money|moneyCompact|m|fmt)\s*\(\s*Number\s*\(/g
  const violations = globSync('{app,components,lib}/**/*.{ts,tsx}', { cwd: webRoot })
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
    .flatMap((path) => {
      const text = source(path)
      return [...text.matchAll(coercion)].map((match) => ({
        path,
        line: text.slice(0, match.index).split('\n').length,
      }))
    })

  assert.deepEqual(violations, [])
})

test('representative report and UI boundaries preserve high-value cents and normal controls', () => {
  const format = createMoneyFormatter('en-US', 'USD')
  const reportMoney = (exactDecimal: string) => format.money(decimalAdd(exactDecimal, decimalNeg('0.0000')))
  const uiMoney = (exactDecimal: string) => format.money(decimalSum([exactDecimal]))

  for (const [value, expected] of [
    ['900719925474099.9400', '$900,719,925,474,099.94'],
    ['1234.5600', '$1,234.56'],
  ] as const) {
    assert.equal(reportMoney(value), expected)
    assert.equal(uiMoney(value), expected)
  }

  const drill = source('lib/report-drill-data.ts')
  assert.match(drill, /value: money\(result\.net\)/)
  assert.match(drill, /money\(decimalAdd\(actual, decimalNeg\(budget\)\)\)/)

  const profitability = source('app/(app)/reports/project-profitability/ProjectProfitabilityTable.tsx')
  assert.match(profitability, /money\(value \?\? '0'/)

  const wip = source('app/(app)/projects/wip-billing/WipBillingWorkspace.tsx')
  assert.match(wip, /decimalSum\(\[/)
  assert.match(wip, /value=\{money\(analytics\.aging\.over90\)\}/)
})

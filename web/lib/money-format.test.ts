import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMoneyFormatter, displayMinorAmount, formatDecimal, minorToMajorText, minorToMajorTextUnits, tryMinorToMajorTextUnits } from './money-format.ts'
import { minorToMajor } from './setup/money-fields.ts'
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

test('minor units convert to an exact major-unit decimal string', () => {
  assert.equal(minorToMajorText('0'), '0.00')
  assert.equal(minorToMajorText('5'), '0.05')
  assert.equal(minorToMajorText('10450'), '104.50')
  assert.equal(minorToMajorText('-250'), '-2.50')
  assert.equal(minorToMajorText('900719925474099393'), '9007199254740993.93')
})

test('registry precision converts per currency without guessing hundredths', () => {
  assert.equal(minorToMajorTextUnits('10450', 2), '104.50')
  assert.equal(minorToMajorTextUnits('1234', 3), '1.234')
  assert.equal(minorToMajorTextUnits('1234', 0), '1234')
  assert.equal(minorToMajorTextUnits('-250', 3), '-0.250')
  assert.equal(minorToMajorTextUnits('5', 0), '5')
})

test('registry conversion reuses the shared setup primitive', () => {
  for (const [minor, units] of [['10450', 2], ['1234', 3], ['1234', 0], ['-250', 3], ['5', 4]] as const) {
    assert.equal(minorToMajorTextUnits(minor, units), minorToMajor(minor, units))
  }
  assert.equal(minorToMajorText('10450'), minorToMajor('10450', 2))
})

test('unknown currency precision refuses by name with the remedy', () => {
  for (const units of [Number.NaN, 1.5, -1, 5]) {
    assert.throws(() => minorToMajorTextUnits('100', units), /unsupported currency precision/)
  }
  // The ISO registry is read-only reference data: the remedy names a
  // supported code, never a Setup edit that cannot exist.
  assert.throws(
    () => minorToMajorTextUnits('100', Number.NaN),
    /ISO currency registry/,
  )
  assert.throws(
    () => minorToMajorTextUnits('100', Number.NaN),
    /supported currency code/,
  )
  assert.throws(() => minorToMajorTextUnits('100', Number.NaN, 'bhd'), /BHD/)
})

test('malformed stored amounts refuse with the replay remedy', () => {
  assert.throws(() => minorToMajorTextUnits('12x', 2, 'USD'), /unreadable minor-unit amount "12x"/)
  assert.throws(() => minorToMajorTextUnits('12x', 2, 'USD'), /replay/)
})

test('display conversion returns null instead of guessing or throwing', () => {
  // Valid registry precisions convert, including the 0..4 edges.
  assert.equal(tryMinorToMajorTextUnits('10450', 2), '104.50')
  assert.equal(tryMinorToMajorTextUnits('1234', 0), '1234')
  // Missing, out-of-range, or non-numeric precision refuses as null: the
  // caller renders its named notice for the currency.
  assert.equal(tryMinorToMajorTextUnits('100', null), null)
  assert.equal(tryMinorToMajorTextUnits('100', undefined), null)
  assert.equal(tryMinorToMajorTextUnits('100', Number.NaN), null)
  assert.equal(tryMinorToMajorTextUnits('100', 1.5), null)
  assert.equal(tryMinorToMajorTextUnits('100', -1), null)
  assert.equal(tryMinorToMajorTextUnits('100', 5), null)
  assert.equal(tryMinorToMajorTextUnits('100', '2'), null)
  // Missing or malformed discount totals never become a zero-value success.
  assert.equal(tryMinorToMajorTextUnits(undefined, 2), null)
  assert.equal(tryMinorToMajorTextUnits(null, 2), null)
  assert.equal(tryMinorToMajorTextUnits('', 2), null)
  assert.equal(tryMinorToMajorTextUnits('12x', 2), null)
})

test('display amounts carry the registry exponent for the formatter', () => {
  // The formatter must render exactly the registry digits: Intl defaults
  // follow the code's built-in metadata and override private/custom codes.
  assert.deepEqual(displayMinorAmount('10450', 2), { major: '104.50', digits: 2 })
  assert.deepEqual(displayMinorAmount('1234', 0), { major: '1234', digits: 0 })
  assert.deepEqual(displayMinorAmount('1234', 3), { major: '1.234', digits: 3 })
  assert.deepEqual(displayMinorAmount('100', null), null)
  assert.deepEqual(displayMinorAmount('100', 5), null)
  assert.deepEqual(displayMinorAmount(undefined, 2), null)
  const format = createMoneyFormatter('en-US', 'XX9')
  const shown = displayMinorAmount('1234', 3)
  assert.notEqual(shown, null)
  // A custom code defaults to two fraction digits in Intl; the registry
  // exponent wins. (Unknown codes render in the existing number-then-code
  // fallback shape; the property under test is the three digits.)
  assert.equal(
    format.money(shown!.major, {
      currency: 'XX9',
      minimumFractionDigits: shown!.digits,
      maximumFractionDigits: shown!.digits,
    }),
    '1.234 XX9',
  )
})

test('decimal strings never cross the binary floating-point boundary', () => {
  const format = createMoneyFormatter('en-US', 'USD')
  assert.equal(
    format.money('9007199254740993.1234', { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    '$9,007,199,254,740,993.1234',
  )
  assert.equal(format.money('-0.0000'), '$0.00')
})

test('decimal formatting preserves exact values without a currency symbol', () => {
  assert.equal(
    formatDecimal('en-US', '9007199254740993.1234', { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    '9,007,199,254,740,993.1234',
  )
})

// ICU emits U+202F (narrow no-break space) as the fr
// grouping separator, and Chromium renders it zero-width in the app's
// system-ui stack (proven: identical pixel widths with and without it) —
// so fr amounts read ungrouped ("110699,26") while the DOM stays correct.
// The formatter must emit the universally rendered U+00A0 instead.
test('fr grouping uses a visibly rendered separator, never U+202F', () => {
  const fr = createMoneyFormatter('fr', 'CAD')
  assert.equal(fr.money(110699.26), '110\u00a0699,26\u00a0$CA')
  assert.ok(!fr.money(110699.26).includes('\u202f'), 'no narrow no-break space in money output')
  assert.ok(!formatDecimal('fr', '110699.26').includes('\u202f'), 'no narrow no-break space in decimal output')
  assert.equal(formatDecimal('fr', '110699.26'), '110\u00a0699,26')
})

// source-pin-contract: exact-decimal hygiene invariant — no money/moneyCompact/m/fmt call site anywhere under web/{app,components,lib} may receive a Number-coerced exact decimal; subjects derived by walking those trees, never hand-listed.
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

})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMoneyFormatter } from './money-format.ts'

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

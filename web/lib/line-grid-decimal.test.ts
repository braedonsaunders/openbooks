import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  displayLineDecimal,
  invalidLineDecimal,
  normalizeLineDecimal,
} from './line-grid-decimal.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('line decimal display removes storage-scale zeroes without rounding', () => {
  assert.equal(displayLineDecimal('1.00000000'), '1')
  assert.equal(displayLineDecimal('35.63000000'), '35.63')
  assert.equal(displayLineDecimal('0.12345678'), '0.12345678')
  assert.equal(displayLineDecimal('9007199254740993.12345678'), '9007199254740993.12345678')
  assert.equal(displayLineDecimal('-0.00000000'), '0')
})

test('line decimal normalization preserves exact meaningful precision', () => {
  assert.equal(normalizeLineDecimal('00012.34000000'), '12.34')
  assert.equal(normalizeLineDecimal('0.00000001'), '0.00000001')
  assert.equal(normalizeLineDecimal(''), '')
  assert.equal(normalizeLineDecimal('1.000000001'), null)
  assert.equal(normalizeLineDecimal('1e3'), null)
})

test('line decimal validation rejects precision loss and malformed input', () => {
  assert.equal(invalidLineDecimal('43.56678400'), false)
  assert.equal(invalidLineDecimal(''), false)
  assert.equal(invalidLineDecimal('43.566784001'), true)
  assert.equal(invalidLineDecimal('not-a-number'), true)
})

test('order and posting-document drawers use exact decimal cells for quantity and rate', () => {
  const orders = source('app/(app)/_order/OrderDrawer.tsx')
  const documents = source('components/document-drawer.tsx')

  for (const drawer of [orders, documents]) {
    assert.match(drawer, /quantity:[^\n]+type: 'decimal'[^\n]+decimalScale: 8/)
    assert.match(drawer, /unit_price:[^\n]+type: 'decimal'[^\n]+decimalScale: 8/)
    assert.doesNotMatch(drawer, /quantity:[^\n]+type: 'amount'/)
    assert.doesNotMatch(drawer, /unit_price:[^\n]+type: 'amount'/)
  }
})

test('transaction grids receive currency-aware amount formatting in view mode', () => {
  const lineGrid = source('components/line-grid.tsx')
  const customFields = source('components/custom-field-inputs.tsx')
  const drawers = [
    source('components/document-drawer.tsx'),
    source('app/(app)/_order/OrderDrawer.tsx'),
    source('app/(app)/journal/JournalDrawer.tsx'),
    source('app/(app)/expenses/ExpenseDrawer.tsx'),
  ]

  assert.match(lineGrid, /c\.type === 'amount'[\s\S]+formatAmount\?\.\(String\(value\)\)/)
  assert.match(lineGrid, /c\.type === 'tax'[\s\S]+formatAmount\?\.\(shown\)/)
  for (const drawer of drawers) {
    assert.match(drawer, /formatAmount=\{\(value\) => money\(value, \{ currency: doc\.currency \}\)\}/)
  }
  assert.match(
    drawers[0]!,
    /bill_amount:[^\n]+money\(row\.billAmount, \{ currency: doc\.currency \}\)/,
  )
  assert.match(customFields, /case 'number':[\s\S]+type: 'decimal'[\s\S]+case 'currency':[\s\S]+type: 'amount'/)
})

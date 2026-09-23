import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCell } from '../src/viz'

/** Strip locale grouping so the assertion holds in any locale: what matters
 *  is the exact digits, not the separator glyph. */
function digits(shown: string): string {
  return shown.replace(/[^0-9.\-]/g, '')
}

test('a currency cell beyond 2^53 prints exactly, never via Number()', () => {
  // Number('9007199254740993.00') is 9007199254740992 — the old path printed
  // …992.00 for a ledger value of …993.00.
  assert.equal(digits(formatCell('9007199254740993.00', 'currency')), '9007199254740993.00')
  assert.equal(digits(formatCell('-9007199254740993.00', 'currency')), '-9007199254740993.00')
})

test('a 3-decimal currency keeps its ledger scale instead of forcing 2 dp', () => {
  assert.equal(digits(formatCell('1234.567', 'currency')), '1234.567')
  assert.equal(digits(formatCell('0.125', 'currency')), '0.125')
})

test('ordinary currency values keep their 2-place ledger shape', () => {
  assert.equal(digits(formatCell('100', 'currency')), '100.00')
  assert.equal(digits(formatCell('2938.10', 'currency')), '2938.10')
  assert.equal(digits(formatCell('-42.50', 'currency')), '-42.50')
})

test('large integer number strings stay exact', () => {
  assert.equal(digits(formatCell('9007199254740993', 'number')), '9007199254740993')
  assert.equal(digits(formatCell('42', 'number')), '42')
})

test('nullish cells still render the placeholder', () => {
  assert.equal(formatCell(null, 'currency'), '—')
  assert.equal(formatCell('', 'number'), '—')
})

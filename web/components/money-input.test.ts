import assert from 'node:assert/strict'
import test from 'node:test'
import { moneyFieldError } from './money-input'

// The shared money-input classifier: every client money answer is refused
// through the single engine decimal classifier, so each of its seven causes
// surfaces with its own remedy here. A decimal-comma value names the dotted
// rewrite (never "remove the separator" — that manufactures a 100x payroll
// error in the seven decimal-comma locales); a genuinely ambiguous comma
// names both readings rather than guessing one.
test('a plain amount is valid', () => {
  assert.equal(moneyFieldError('Amount', 'a money amount', '1234.56'), null)
  assert.equal(moneyFieldError('Amount', 'a money amount', '-40'), null)
  assert.equal(moneyFieldError('Amount', 'a money amount', '0'), null)
})

test('blank is valid unless the field requires an answer', () => {
  assert.equal(moneyFieldError('Amount', 'a money amount', ''), null)
  assert.equal(moneyFieldError('Amount', 'a money amount', '   '), null)
  assert.match(
    moneyFieldError('Amount', 'a money amount', '', 4, { required: true }) ?? '',
    /Amount is empty/,
  )
})

test('a decimal comma names the dotted rewrite', () => {
  assert.equal(
    moneyFieldError('Amount', 'a money amount', '12,34'),
    'Amount must use "." as the decimal point — write "12,34" as "12.34" and try again',
  )
})

test('a dot-grouped decimal comma rewrites through the last separator', () => {
  assert.equal(
    moneyFieldError('Amount', 'a money amount', '1.234,56'),
    'Amount must use "." as the decimal point — write "1.234,56" as "1234.56" and try again',
  )
})

test('an ambiguous comma names both readings instead of guessing', () => {
  assert.match(
    moneyFieldError('Amount', 'a money amount', '1,234') ?? '',
    /could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/,
  )
})

test('a thousands separator is refused by name', () => {
  assert.match(
    moneyFieldError('Amount', 'a money amount', '1,234.56') ?? '',
    /must not contain a thousands separator/,
  )
})

test('too many decimals name the scale', () => {
  assert.match(
    moneyFieldError('Amount', 'a money amount', '1.23456') ?? '',
    /at most 4 decimal places/,
  )
})

test('a currency symbol and scientific notation are refused by name', () => {
  assert.match(moneyFieldError('Amount', 'a money amount', '$12') ?? '', /currency symbol/)
  assert.match(moneyFieldError('Amount', 'a money amount', '1e3') ?? '', /scientific notation/)
})

test('gibberish is refused as not a number', () => {
  assert.match(moneyFieldError('Amount', 'a money amount', 'abc') ?? '', /is not a number/)
})

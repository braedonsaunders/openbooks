import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertValidPasswordExpression,
  PasswordExpressionError,
  renderPasswordExpression,
  type PasswordTokenCatalog,
} from './password-expression'

/**
 * The stub-password rule is tenant configuration over confidential data, so
 * the two properties that matter are: it produces exactly what the employer
 * published to staff, and anything it does not understand FAILS — a token that
 * silently rendered as nothing would weaken every password derived from it.
 */

const CATALOG: PasswordTokenCatalog = {
  surname: 'text',
  givenName: 'text',
  employeeNumber: 'text',
  dob: 'date',
}

const EMPLOYEE = {
  surname: 'Hopper',
  givenName: 'Grace',
  employeeNumber: 'E-4471',
  dob: '1906-12-09',
}

test("the customer's rule: first three of the surname + DOB as MMDDYYYY", () => {
  assert.equal(
    renderPasswordExpression('{surname:3}{dob:MMDDYYYY}', CATALOG, EMPLOYEE),
    'Hop12091906',
  )
  assert.equal(
    renderPasswordExpression('{surname:3|upper}{dob:MMDDYYYY}', CATALOG, EMPLOYEE),
    'HOP12091906',
  )
})

test('literals, whole values, and the other date layouts', () => {
  assert.equal(renderPasswordExpression('{surname}', CATALOG, EMPLOYEE), 'Hopper')
  assert.equal(renderPasswordExpression('{givenName:1|lower}-{dob:YYYYMMDD}', CATALOG, EMPLOYEE), 'g-19061209')
  assert.equal(renderPasswordExpression('pay{dob:DDMMYY}', CATALOG, EMPLOYEE), 'pay091206')
  assert.equal(renderPasswordExpression('{dob:YYYY}{surname:2}', CATALOG, EMPLOYEE), '1906Ho')
  // Punctuation and accents are dropped so the value types the way the
  // employer's published rule reads it.
  assert.equal(
    renderPasswordExpression('{employeeNumber}', CATALOG, EMPLOYEE),
    'E4471',
  )
  assert.equal(
    renderPasswordExpression('{surname:4}', CATALOG, { ...EMPLOYEE, surname: "O'Brién" }),
    'OBri',
  )
})

test('an unknown token is REJECTED, never silently emptied', () => {
  assert.throws(
    () => renderPasswordExpression('{sin:3}{dob:MMDDYYYY}', CATALOG, EMPLOYEE),
    (error: unknown) => {
      assert.ok(error instanceof PasswordExpressionError)
      assert.match((error as Error).message, /unknown token "sin"/)
      // The message names what IS available, so the rule can be fixed.
      assert.match((error as Error).message, /surname/)
      return true
    },
  )
  // Validation refuses it at save time too — not only at send time.
  assert.throws(
    () => assertValidPasswordExpression('{payDate:MMDDYYYY}', CATALOG),
    PasswordExpressionError,
  )
})

test('malformed expressions are rejected', () => {
  const bad = [
    '{surname:3', // unbalanced
    'surname}', // unbalanced
    '{dob}', // a date needs a format
    '{dob:MM-DD-YYYY}', // not an allowed layout
    '{surname:0}', // length out of range
    '{surname:99}',
    '{surname:three}',
    '{surname|shout}', // unknown modifier
    '{surname:3:4}', // too many arguments
    'static-password', // no record value at all
    '', // empty
  ]
  for (const expression of bad) {
    assert.throws(
      () => assertValidPasswordExpression(expression, CATALOG),
      PasswordExpressionError,
      `expected "${expression}" to be rejected`,
    )
  }
})

test('a record missing the value fails rather than shortening the password', () => {
  assert.throws(
    () => renderPasswordExpression('{surname:3}{dob:MMDDYYYY}', CATALOG, { ...EMPLOYEE, dob: null }),
    (error: unknown) => {
      assert.match((error as Error).message, /no value for "dob"/)
      return true
    },
  )
  assert.throws(
    () => renderPasswordExpression('{surname:3}', CATALOG, { surname: '   ' }),
    PasswordExpressionError,
  )
  // A name with no usable characters cannot stand in for a password component.
  assert.throws(
    () => renderPasswordExpression('{surname:3}', CATALOG, { surname: '¿?!' }),
    PasswordExpressionError,
  )
  assert.throws(
    () => renderPasswordExpression('{dob:MMDDYYYY}', CATALOG, { dob: 'December 9 1906' }),
    PasswordExpressionError,
  )
})

test('braces can be escaped into the password itself', () => {
  assert.equal(
    renderPasswordExpression('{{{surname:2}}}', CATALOG, EMPLOYEE),
    '{Ho}',
  )
})

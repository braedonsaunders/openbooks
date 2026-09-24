// Run with: node --import tsx --test packages/forms-core/src/evaluator.test.ts
//
// The formula evaluator is exact bigint-rational math with fail-closed
// errors: garbage and divide-by-zero throw a named refusal instead of
// coercing to 0, and blanks propagate instead of vanishing into sums.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateFormulaTree,
  FormulaEvaluationError,
  resolveDefaultValue,
  type EvalContext,
  type FormulaExpression,
} from './index'

const ctx: EvalContext = { values: {}, rows: {} }
const sumOf = (values: Array<number | string>): FormulaExpression => ({
  kind: 'sum',
  of: values.map((value) => ({ kind: 'literal', value })),
})

test('decimal arithmetic is exact, not the nearest double', () => {
  assert.equal(evaluateFormulaTree(sumOf([0.1, 0.2]), ctx), 0.3)
  assert.equal(
    evaluateFormulaTree(
      { kind: 'product', of: [{ kind: 'literal', value: 19.99 }, { kind: 'literal', value: 3 }] },
      ctx,
    ),
    59.97,
  )
  // Math.round(2.675 * 100) / 100 is 2.67 in floating point; exactly it is 2.68.
  assert.equal(
    evaluateFormulaTree({ kind: 'round', of: { kind: 'literal', value: 2.675 }, places: 2 }, ctx),
    2.68,
  )
})

test('divide-by-zero throws a named refusal instead of returning 0', () => {
  assert.throws(
    () =>
      evaluateFormulaTree(
        {
          kind: 'divide',
          left: { kind: 'literal', value: 10 },
          right: { kind: 'literal', value: 0 },
        },
        ctx,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FormulaEvaluationError)
      assert.match((error as Error).message, /divide by zero/)
      return true
    },
  )
  assert.throws(
    () =>
      evaluateFormulaTree(
        {
          kind: 'divide',
          left: { kind: 'literal', value: 0 },
          right: { kind: 'literal', value: 0 },
        },
        ctx,
      ),
    FormulaEvaluationError,
  )
})

test('garbage operands throw naming the field instead of coercing to 0', () => {
  assert.throws(
    () =>
      evaluateFormulaTree(sumOf(['abc']), {
        values: {},
        rows: {},
      }),
    /not a number/,
  )
  assert.throws(
    () =>
      evaluateFormulaTree(
        { kind: 'sum', of: [{ kind: 'field_ref', fieldKey: 'price' }] },
        { values: { price: 'twelve' }, rows: {} },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FormulaEvaluationError)
      assert.match((error as Error).message, /"price"/)
      return true
    },
  )
  assert.throws(
    () => evaluateFormulaTree(sumOf([true as never]), ctx),
    FormulaEvaluationError,
  )
})

test('empty and blank inputs stay blank instead of becoming 0', () => {
  assert.equal(evaluateFormulaTree({ kind: 'sum', of: [] }, ctx), null)
  assert.equal(evaluateFormulaTree({ kind: 'product', of: [] }, ctx), null)
  assert.equal(evaluateFormulaTree({ kind: 'min', of: [] }, ctx), null)
  assert.equal(evaluateFormulaTree({ kind: 'max', of: [] }, ctx), null)
  assert.equal(evaluateFormulaTree({ kind: 'sum_section', sectionKey: 'lines', rowFieldKey: 'amount' }, ctx), null)
  // A missing operand propagates blank through binary operators.
  assert.equal(
    evaluateFormulaTree(
      {
        kind: 'subtract',
        left: { kind: 'field_ref', fieldKey: 'missing' },
        right: { kind: 'literal', value: 5 },
      },
      ctx,
    ),
    null,
  )
  // Blanks are skipped, not zeroed, inside n-ary operators.
  assert.equal(
    evaluateFormulaTree(
      {
        kind: 'sum',
        of: [{ kind: 'literal', value: 5 }, { kind: 'field_ref', fieldKey: 'missing' }],
      },
      ctx,
    ),
    5,
  )
})

test('section averages skip blank rows instead of zeroing them', () => {
  assert.equal(
    evaluateFormulaTree(
      { kind: 'avg_section', sectionKey: 'lines', rowFieldKey: 'amount' },
      { values: {}, rows: { lines: [{ amount: 5 }, {}] } },
    ),
    5,
  )
  assert.equal(
    evaluateFormulaTree(
      { kind: 'avg_section', sectionKey: 'lines', rowFieldKey: 'amount' },
      { values: {}, rows: { lines: [] } },
    ),
    null,
  )
})

test('results beyond double precision persist as exact strings', () => {
  const result = evaluateFormulaTree(
    {
      kind: 'product',
      of: [{ kind: 'literal', value: '999999999999999.9999' }, { kind: 'literal', value: 1 }],
    },
    ctx,
  )
  assert.strictEqual(result, '999999999999999.9999')
})

test('roots refuse instead of returning 0', () => {
  // An exact integer root still works.
  assert.equal(
    evaluateFormulaTree(
      { kind: 'root', of: { kind: 'literal', value: 9 }, degree: { kind: 'literal', value: 2 } },
      ctx,
    ),
    3,
  )
  assert.throws(
    () =>
      evaluateFormulaTree(
        { kind: 'root', of: { kind: 'literal', value: 9 }, degree: { kind: 'literal', value: 0 } },
        ctx,
      ),
    /zeroth root/,
  )
  // An even root of a negative has no real result: refusal, not 0.
  assert.throws(
    () =>
      evaluateFormulaTree(
        { kind: 'root', of: { kind: 'literal', value: -9 }, degree: { kind: 'literal', value: 2 } },
        ctx,
      ),
    FormulaEvaluationError,
  )
})

test('a failing expression default resolves to no default', () => {
  assert.equal(
    resolveDefaultValue(
      {
        kind: 'expression',
        expr: {
          kind: 'divide',
          left: { kind: 'literal', value: 1 },
          right: { kind: 'literal', value: 0 },
        },
      },
      ctx,
    ),
    undefined,
  )
})

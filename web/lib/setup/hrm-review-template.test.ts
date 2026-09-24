import assert from 'node:assert/strict'
import test from 'node:test'
import { HrmReviewTemplateScaleError, normalizeHrmReviewTemplateInput } from './hrm-review-template'

/**
 * Review-template scale slot folding (pure unit — no database). The drawer
 * edits min/max/labels as structured fields; the fold rebuilds the
 * ratingScale object before buildRow so the slot keys never reach the
 * column writer. Other entities pass through untouched.
 */

test('scale slots fold into ratingScale', () => {
  assert.deepEqual(
    normalizeHrmReviewTemplateInput('hrm-review-templates', {
      name: 'Annual',
      ratingScaleMin: 1,
      ratingScaleMax: 5,
      ratingScaleLabels: ['low', 'high'],
    }),
    { name: 'Annual', ratingScale: { min: 1, max: 5, labels: ['low', 'high'] } },
  )
})

test('partial slots fold only what is present', () => {
  assert.deepEqual(
    normalizeHrmReviewTemplateInput('hrm-review-templates', { ratingScaleMax: 7 }),
    { ratingScale: { max: 7 } },
  )
})

test('bodies without slots pass through untouched', () => {
  const body = { name: 'Annual' }
  assert.equal(normalizeHrmReviewTemplateInput('hrm-review-templates', body), body)
})

test('other entities pass through untouched', () => {
  const body = { ratingScaleMin: 1 }
  assert.equal(normalizeHrmReviewTemplateInput('hrm-process-templates', body), body)
})

test('string bounds from integer inputs coerce to numbers', () => {
  assert.deepEqual(
    normalizeHrmReviewTemplateInput('hrm-review-templates', {
      name: 'Annual',
      ratingScaleMin: '1',
      ratingScaleMax: '3',
      ratingScaleLabels: ['low', 'mid', 'high'],
    }),
    { name: 'Annual', ratingScale: { min: 1, max: 3, labels: ['low', 'mid', 'high'] } },
  )
})

test('a directly posted scale object coerces the same way', () => {
  assert.deepEqual(
    normalizeHrmReviewTemplateInput('hrm-review-templates', {
      name: 'Annual',
      ratingScale: { min: '1', max: '5', labels: [] },
    }),
    { name: 'Annual', ratingScale: { min: 1, max: 5, labels: [] } },
  )
})

test('unparseable bounds are refused by field name', () => {
  assert.throws(
    () => normalizeHrmReviewTemplateInput('hrm-review-templates', { ratingScaleMin: 'abc', ratingScaleMax: 3 }),
    (e: unknown) => e instanceof HrmReviewTemplateScaleError && /ratingScaleMin/.test((e as Error).message),
  )
  assert.throws(
    () => normalizeHrmReviewTemplateInput('hrm-review-templates', { ratingScale: { min: 1, max: '' } }),
    (e: unknown) => e instanceof HrmReviewTemplateScaleError && /ratingScale\.max/.test((e as Error).message),
  )
  assert.throws(
    () => normalizeHrmReviewTemplateInput('hrm-review-templates', { ratingScaleMax: Number.NaN }),
    HrmReviewTemplateScaleError,
  )
})

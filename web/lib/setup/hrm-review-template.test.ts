import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHrmReviewTemplateInput } from './hrm-review-template'

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

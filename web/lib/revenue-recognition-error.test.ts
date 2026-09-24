import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RevenueRecognitionError,
  StaleRecognitionPreviewError,
} from '../../engine/src/revenue/recognition.ts'
import { revenueRecognitionErrorResponse } from './revenue-recognition-error.ts'

test('revenue domain refusals keep the named engine message at 422', async () => {
  const closed = revenueRecognitionErrorResponse(
    new RevenueRecognitionError('January 2026: GL period closed'),
    'Unable to run revenue recognition.',
  )
  assert.equal(closed.status, 422)
  assert.deepEqual(await closed.json(), { error: 'January 2026: GL period closed' })

  const inverted = revenueRecognitionErrorResponse(
    new RevenueRecognitionError('recognition end (2026-02-28) precedes the recognition start (2026-03-01)'),
    'Unable to preview revenue recognition.',
  )
  assert.equal(inverted.status, 422)
  assert.match(
    (await inverted.json() as { error: string }).error,
    /precedes the recognition start/,
  )
})

test('a stale confirmation stays a 409 naming the remedy', async () => {
  const stale = revenueRecognitionErrorResponse(
    new StaleRecognitionPreviewError('the reviewed set changed'),
    'Unable to run revenue recognition.',
  )
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), { error: 'stale_preview' })
})

test('unexpected revenue write defects stay a generic 500', async () => {
  const failed = revenueRecognitionErrorResponse(
    new Error('recognition journal could not be linked to its plan'),
    'Unable to run revenue recognition.',
  )
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { error: 'Unable to run revenue recognition.' })
})

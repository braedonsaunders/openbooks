import assert from 'node:assert/strict'
import test from 'node:test'
import { AllocationRunError } from '../../../../engine/src/allocations/period-run.ts'
import { allocationRunErrorResponse } from '../../../lib/allocations-run-error.ts'

test('allocation write refusals keep the named engine message at 404/422', async () => {
  const closed = allocationRunErrorResponse(
    new AllocationRunError('INVALID', 'the GL period January 2026 is closed and cannot take allocation postings'),
    'Unable to post the allocation run.',
  )
  assert.equal(closed.status, 422)
  assert.deepEqual(await closed.json(), {
    error: 'the GL period January 2026 is closed and cannot take allocation postings',
  })

  const missing = allocationRunErrorResponse(
    new AllocationRunError('NOT_FOUND', 'allocation run 00000000-0000-4000-8000-000000000001 was not found'),
    'Unable to post the allocation run.',
  )
  assert.equal(missing.status, 404)
  assert.match((await missing.json() as { error: string }).error, /was not found/)
})

test('unexpected allocation write defects stay a generic 500', async () => {
  const failed = allocationRunErrorResponse(new Error('allocation lines do not balance (0.0001)'), 'Unable to post the allocation run.')
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { error: 'Unable to post the allocation run.' })
})

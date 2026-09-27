import assert from 'node:assert/strict'
import test from 'node:test'
import { AllocationRunError } from '../../../../engine/src/allocations/period-run.ts'
import { allocationRunErrorResponse } from '../../../lib/allocations-run-error.ts'

test('allocation run refusals map missing records uniformly and preserve domain messages', async () => {
  const closed = await allocationRunErrorResponse(
    new AllocationRunError('INVALID', 'the GL period January 2026 is closed and cannot take allocation postings'),
    'Unable to post the allocation run.',
  )
  assert.equal(closed.status, 422)
  assert.deepEqual(await closed.json(), {
    error: 'the GL period January 2026 is closed and cannot take allocation postings',
  })

  const missing = await allocationRunErrorResponse(
    new AllocationRunError('NOT_FOUND', 'allocation run 00000000-0000-4000-8000-000000000001 was not found'),
    'Unable to post the allocation run.',
  )
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'not_found' })
})

test('unexpected allocation write defects stay a generic 500', async () => {
  const failed = await allocationRunErrorResponse(new Error('allocation lines do not balance (0.0001)'), 'Unable to post the allocation run.')
  assert.equal(failed.status, 500)
  const body = await failed.json() as { error: string; requestId: string }
  assert.ok(body.requestId && /unexpected error/i.test(body.error))
})

test('configuration-write denials hide missing and out-of-scope behind one bare 404', async () => {
  const { allocationWriteErrorResponse } = await import('../../../lib/allocations-run-error.ts')
  const { AllocationRuleError } = await import('../../../../engine/src/allocations/index.ts')
  const denied = await allocationWriteErrorResponse(new AllocationRuleError('NOT_FOUND', 'not found'))
  assert.equal(denied.status, 404)
  assert.deepEqual(await denied.json(), { error: 'not_found' })
  const missing = await allocationWriteErrorResponse(new AllocationRuleError('NOT_FOUND', 'allocation rule version not found: x'))
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'not_found' })
  assert.equal((await allocationWriteErrorResponse(new AllocationRuleError('INVALID', 'dimensionFilters.subsidiaryIds must be an array'))).status, 422)
})

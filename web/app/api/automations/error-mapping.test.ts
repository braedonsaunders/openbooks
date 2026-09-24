// F4T-12: a save over a moved recipe answers 409 with the stored version
// carried, never a 422 validation failure and never a bare internal error.
import assert from 'node:assert/strict'
import test from 'node:test'
import { automationErrorResponse } from './_lib'
import {
  AutomationServiceError,
  AutomationVersionConflictError,
} from '@openbooks/engine/src/automations/services.ts'

test('a version conflict answers 409 with the stored version carried', async () => {
  const res = automationErrorResponse(new AutomationVersionConflictError(7))
  assert.equal(res.status, 409)
  const body = (await res.json()) as { error: string; code: string; version: number }
  assert.equal(body.code, 'automation_stale_version')
  assert.equal(body.version, 7)
  assert.match(body.error, /now at version 7/)
})

test('ordinary service refusals keep their 422 mapping', async () => {
  const res = automationErrorResponse(new AutomationServiceError('the automation needs a non-blank name'))
  assert.equal(res.status, 422)
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { hasFlowApprovalReleaseHandler, handlerReleasedSubjectKinds } = await import(
  '@openbooks/engine/src/flows/index.ts'
)
const { registerFlowApprovalReleaseHandlers } = await import('./flow-approval-releases')
const { installEngineSeams } = await import('@openbooks/engine/src/composition/install.ts')

test('every hook-delegated subject kind has a boot-registered release handler', async () => {
  installEngineSeams()
  await registerFlowApprovalReleaseHandlers()
  const kinds = handlerReleasedSubjectKinds()
  // Anti-vacuity: the defect was a missing crew_time_batch handler, so the
  // derived set must contain it — an empty set would pass the loop below
  // while proving nothing.
  assert.ok(kinds.includes('crew_time_batch'), `derived registry must include crew_time_batch, got ${kinds.join(',')}`)
  for (const kind of kinds) {
    assert.equal(
      hasFlowApprovalReleaseHandler(kind),
      true,
      `no release handler registered for ${kind} — its approval gates would strand pending forever`,
    )
  }
})

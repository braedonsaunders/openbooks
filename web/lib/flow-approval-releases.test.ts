import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Scheduling approvals are optional Flows: shift requests and governed
// schedule publications are released only through their registered
// handlers, so every process that decides gates must have them installed.
test('shift requests and governed schedule publications release through boot-registered handlers', async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export%20{}' }
    return next(specifier, context)
  } })
  const { hasFlowApprovalReleaseHandler, handlerReleasedSubjectKinds, listFlowSubjectProfiles } = await import('@openbooks/engine/flows/module')
  const releaseModule: string = './flow-approval-releases?scheduling-release-test'
  const { registerFlowApprovalReleaseHandlers } = await import(releaseModule) as typeof import('./flow-approval-releases')
  const { installEngineSeams } = await import('@openbooks/engine/composition/install')
  hooks.deregister()
  installEngineSeams()
  await registerFlowApprovalReleaseHandlers()
  const kinds = handlerReleasedSubjectKinds()
  for (const kind of ['schedule_entry_request', 'schedule_publication']) {
    assert.ok(kinds.includes(kind), `${kind} is released by its handler, never by a flow status action`)
    assert.equal(hasFlowApprovalReleaseHandler(kind), true, `${kind} has a registered release handler`)
    const profile = listFlowSubjectProfiles().find((candidate) => candidate.subjectKind === kind)
    assert.deepEqual(profile?.triggers, ['on_submit'], `${kind} is submitted to Flows on submit`)
  }
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return nextLoad(url, context)
  },
})
const { createPrebill, PreBillingError } = await import('./pre-billing')
hooks.deregister()

test('prebill rejects impossible calendar dates before reaching SQL', async () => {
  for (const periodEnd of ['2026-02-30', '2026-13-01']) {
    await assert.rejects(
      createPrebill('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', {
        projectId: '00000000-0000-0000-0000-000000000000',
        periodEnd,
      }),
      (error: unknown) => error instanceof PreBillingError && /Period end must be a valid date/.test(error.message),
    )
  }
})

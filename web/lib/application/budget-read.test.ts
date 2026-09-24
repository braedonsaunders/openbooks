import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { listApplicationBudgets } = await import('./budgets')
const context = {
  authz: { user: { orgId: 'budget-read-unit-test' }, permissions: new Set(), allowedSubsidiaryIds: null },
  source: 'api', requestId: 'budget-read-unit-request', apiKeyId: null,
} as unknown as ApplicationContext

test('budget list refuses before database access without budgets.read', async () => {
  await assert.rejects(
    listApplicationBudgets(context),
    (error: unknown) => error instanceof ApplicationError
      && error.code === 'forbidden'
      && error.status === 403
      && error.details?.permission === 'budgets.read',
  )
})

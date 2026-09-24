import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { listApplicationBudgets } = await import('./budgets')

test('disabled budgets are refused with the Features-page remedy', async () => {
  const org = await createScratchOrg()
  const context = {
    authz: { user: { orgId: org.orgId }, permissions: new Set(['budgets.read']), allowedSubsidiaryIds: null },
    source: 'api', requestId: 'budget-read-feature-test', apiKeyId: null,
  } as unknown as ApplicationContext
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"budgets":false}'::jsonb,
           true
         )
       where id = ${org.orgId}
    `))
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(
        listApplicationBudgets(context),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'not_found'
          && error.status === 404
          && error.message === 'budgets is off; enable it from GET /api/v1/settings/features',
      )
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

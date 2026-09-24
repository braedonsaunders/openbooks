import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, _context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord, deleteSetupRecord } = await import('./write.ts')

test('generic setup writes refuse competency configuration owned by scoped services', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  try {
    await withBypass(() => db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true,"hrmCompetencies":true}'::jsonb)
       where id = ${org.orgId}`))
    const actor = { orgId: org.orgId, id: actorId, permissions: ['admin.setup.manage'] }
    for (const entityKey of ['hrm-competency-frameworks', 'hrm-competencies']) {
      const created = await withBypass(() => createSetupRecord(actor, entityKey, { name: 'unscoped config' }))
      assert.equal(created.status, 405)
      assert.equal(created.body.error, 'read-only')
      const updated = await withBypass(() => updateSetupRecord(actor, entityKey, { id: '00000000-0000-7000-8000-000000000001', name: 'unscoped config' }))
      assert.equal(updated.status, 405)
      const deleted = await withBypass(() => deleteSetupRecord(actor, entityKey, '00000000-0000-7000-8000-000000000001'))
      assert.equal(deleted.status, 405)
    }
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

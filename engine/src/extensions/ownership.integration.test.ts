import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env, withBypass } from '../platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts'
import { installTestExtension } from '../testing/extension-packages.ts'

test('database refuses another extension active version within the same tenant', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(orgId, 'Owner proof', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${orgId} and key = 'admin'`))
  try {
    const install = (key: string) => withBypass(() => installTestExtension({ orgId, actorId, manifest: { key, name: key, version: '1.0.0', permissions: [], contributions: [] } }))
    const one = await install('owner-one'); const two = await install('owner-two')
    await assert.rejects(withBypass(() => db.execute(sql`update apps set active_version_id = ${two.versionId} where id = ${one.extensionId} and org_id = ${orgId}`)), (error: unknown) => { let current = error; while (current instanceof Error) { if (current.message.includes('apps_active_version_owner_fkey')) return true; current = current.cause } return false })
  } finally { await withBypass(() => dropScratchOrg(orgId)) }
})

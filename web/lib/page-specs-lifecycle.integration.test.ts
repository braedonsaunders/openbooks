import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { installModule } = await import('@openbooks/engine/src/modules/installer.ts')
const { loadPageSpec } = await import('./page-specs.ts')

test('page resolution excludes disabled modules and stale projections even if the page row remains active', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(orgId, 'Layout admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${orgId} and key = 'admin'`))
  try {
    const installed = await withBypass(() => installModule({ orgId, actorId, installerEffectivePermissions: ['*'], manifest: { key: 'reader-proof', name: 'Reader proof', version: '1.0.0', permissions: [], contributions: [{ kind: 'page', route: '/banking', spec: { specVersion: 1, route: '/banking', layout: 'list', header: [], body: [] } }] } }))
    const load = () => withBypass(() => loadPageSpec(orgId, '/banking', { widgets: new Set(), frames: new Set() }))
    assert.equal((await load())?.moduleVersionId, installed.versionId)
    await withBypass(() => db.execute(sql`update modules set status = 'disabled' where id = ${installed.moduleId}`))
    assert.equal(await load(), null)
    await withBypass(() => db.execute(sql`update modules set status = 'installed', active_version_id = null where id = ${installed.moduleId}`))
    assert.equal(await load(), null)
  } finally { await withBypass(() => dropScratchOrg(orgId)) }
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { page, frame, widgetBlock } = await import('@braedonsaunders/appkit-viewspec')
const { savePageSpec, restorePageSpec } = await import('./page-specs.ts')

/**
 * Layout-restore scope: a restore must supersede only the layer it publishes
 * to — exactly like save and clear already do. Restoring an org version must
 * leave every personal layout alone, and restoring must never deactivate a
 * layer it does not republish.
 */

const registries = {
  widgets: new Set(['stat-tile-row', 'banking-roster', 'save-view']),
  frames: new Set(['page-container', 'card']),
}

const spec = (note: string) =>
  page({
    route: '/banking',
    body: [frame('card', [widgetBlock('banking-roster', { accounts: [], note })])],
  }) as never

async function activeRows(orgId: string, route: string) {
  return (
    await withBypass(() =>
      db.execute<{ id: string; userId: string | null }>(sql`
        select id, user_id as "userId" from page_specs
         where org_id = ${orgId} and route = ${route} and is_active
         order by user_id nulls first
      `),
    )
  ).rows
}

test('restoring an org version leaves personal layouts active', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await withBypass(() => createScratchOrg())
  const adminId = await withBypass(() => createScratchUser(orgId, 'Layout admin', 'admin'))
  const userId = await withBypass(() => createScratchUser(orgId, 'Layout user', 'admin'))
  try {
    const v1 = await withBypass(() =>
      savePageSpec({ orgId, actorId: adminId, route: '/banking', spec: spec('org v1'), registries }),
    )
    assert.equal(v1.ok, true, 'org v1 saves')
    const personal = await withBypass(() =>
      savePageSpec({ orgId, actorId: userId, route: '/banking', spec: spec('personal'), registries, scope: 'user' }),
    )
    assert.equal(personal.ok, true, 'personal layout saves')
    const v2 = await withBypass(() =>
      savePageSpec({ orgId, actorId: adminId, route: '/banking', spec: spec('org v2'), registries }),
    )
    assert.equal(v2.ok, true, 'org v2 saves')
    if (!v1.ok || !v2.ok) throw new Error('seed saves failed')

    const restored = await withBypass(() =>
      restorePageSpec({ orgId, actorId: adminId, route: '/banking', versionId: v1.id, registries }),
    )
    assert.equal(restored.ok, true, 'restore succeeds')

    const rows = await activeRows(orgId, '/banking')
    const personalStillActive = rows.some((r) => r.userId === userId)
    assert.equal(personalStillActive, true, 'the personal layout must survive an org restore')
    assert.equal(
      rows.filter((r) => r.userId === null).length,
      1,
      'exactly one org layout is active after the restore',
    )
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('restoring a personal version republishes only the personal layer', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await withBypass(() => createScratchOrg())
  const adminId = await withBypass(() => createScratchUser(orgId, 'Layout admin', 'admin'))
  const userId = await withBypass(() => createScratchUser(orgId, 'Layout user', 'admin'))
  try {
    const org = await withBypass(() =>
      savePageSpec({ orgId, actorId: adminId, route: '/banking', spec: spec('org'), registries }),
    )
    assert.equal(org.ok, true, 'org layout saves')
    const p1 = await withBypass(() =>
      savePageSpec({ orgId, actorId: userId, route: '/banking', spec: spec('personal v1'), registries, scope: 'user' }),
    )
    assert.equal(p1.ok, true, 'personal v1 saves')
    const p2 = await withBypass(() =>
      savePageSpec({ orgId, actorId: userId, route: '/banking', spec: spec('personal v2'), registries, scope: 'user' }),
    )
    assert.equal(p2.ok, true, 'personal v2 saves')
    if (!p1.ok) throw new Error('seed saves failed')

    const restored = await withBypass(() =>
      restorePageSpec({ orgId, actorId: userId, route: '/banking', versionId: p1.id, registries, scope: 'user' }),
    )
    assert.equal(restored.ok, true, 'personal restore succeeds')

    const rows = await activeRows(orgId, '/banking')
    assert.equal(rows.length, 2, 'org plus personal stay active')
    assert.equal(
      rows.filter((r) => r.userId === null).length,
      1,
      'the org layout survives a personal restore',
    )
    const mine = rows.find((r) => r.userId === userId)
    assert.ok(mine, 'a personal layout is active')
    if (!restored.ok) throw new Error('restore failed')
    assert.equal(mine!.id, restored.id, 'the restored row is the active personal layout')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('a refused restore leaves every layer untouched', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await withBypass(() => createScratchOrg())
  const adminId = await withBypass(() => createScratchUser(orgId, 'Layout admin', 'admin'))
  const userId = await withBypass(() => createScratchUser(orgId, 'Layout user', 'admin'))
  try {
    const v1 = await withBypass(() =>
      savePageSpec({ orgId, actorId: adminId, route: '/banking', spec: spec('org v1'), registries }),
    )
    assert.equal(v1.ok, true, 'org v1 saves')
    const personal = await withBypass(() =>
      savePageSpec({ orgId, actorId: userId, route: '/banking', spec: spec('personal'), registries, scope: 'user' }),
    )
    assert.equal(personal.ok, true, 'personal layout saves')
    const before = await activeRows(orgId, '/banking')

    const refused = await withBypass(() =>
      restorePageSpec({
        orgId,
        actorId: adminId,
        route: '/banking',
        versionId: '00000000-0000-0000-0000-000000000000',
        registries,
      }),
    )
    assert.equal(refused.ok, false, 'unknown version is refused')
    assert.deepEqual(await activeRows(orgId, '/banking'), before, 'a refused restore changes nothing')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

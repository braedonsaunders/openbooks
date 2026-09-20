import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const {
  createHomeAnnouncementRow,
  deleteHomeAnnouncementRow,
  liveHomeAnnouncements,
  loadHomeAnnouncementRows,
  saveHomeAnnouncementRow,
} = await import('./home-announcements.ts')
const { createSetupRecord, deleteSetupRecord, updateSetupRecord } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

const DB = !!env.OPENBOOKS_DB_URL

async function actor(orgId: string): Promise<string> {
  const userId = await withBypass(() => createScratchUser(orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${orgId} and key = 'admin'`))
  return userId
}

/**
 * HR-15 home announcements: CRUD over org settings JSON through the Setup
 * write path, audience/date filtering for the home card, tenant isolation,
 * and the feature fence (writes 404 while homeAnnouncements is off).
 */
test('announcements author through setup, filter live by audience and date, and isolate tenants', { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const other = await withBypass(() => createScratchOrg())
  const userId = await actor(org.orgId)
  const authz = { orgId: org.orgId, id: userId, permissions: ['*'] }
  try {
    assert.deepEqual(await withBypass(() => loadHomeAnnouncementRows(org.orgId)), [])
    const one = await withBypass(() => createHomeAnnouncementRow(org.orgId, {
      title: 'Holiday party', body: 'December 12', audience: 'all', startsOn: '2026-12-01', endsOn: '2026-12-12',
    }))
    const two = await withBypass(() => createHomeAnnouncementRow(org.orgId, {
      title: 'Manager offsite', audience: 'managers', startsOn: '2026-11-01',
    }))
    assert.equal((await withBypass(() => loadHomeAnnouncementRows(org.orgId))).length, 2)
    // Tenant isolation: the neighbour org sees nothing.
    assert.deepEqual(await withBypass(() => loadHomeAnnouncementRows(other.orgId)), [])
    // Audience scope: employees never see the managers-only row.
    const employee = await liveHomeAnnouncements(org.orgId, 'employee', '2026-11-15')
    assert.deepEqual(employee.map((row) => row.title), [])
    const manager = await liveHomeAnnouncements(org.orgId, 'manager', '2026-11-15')
    assert.deepEqual(manager.map((row) => row.title), ['Manager offsite'])
    // Dates: nothing live before its start; everything gone after its end.
    assert.deepEqual((await liveHomeAnnouncements(org.orgId, 'admin', '2026-10-01')).length, 0)
    assert.deepEqual(
      (await liveHomeAnnouncements(org.orgId, 'admin', '2026-12-05')).map((row) => row.title),
      ['Holiday party', 'Manager offsite'],
    )
    // An open-ended row stays live; the ended row is gone.
    assert.deepEqual(
      (await liveHomeAnnouncements(org.orgId, 'admin', '2027-01-01')).map((row) => row.title),
      ['Manager offsite'],
    )
    // Edit + delete through the module functions.
    await withBypass(() => saveHomeAnnouncementRow(org.orgId, one.id, {
      title: 'Holiday party!', audience: 'all', startsOn: '2026-12-01', endsOn: '2026-12-12',
    }))
    assert.equal(
      (await withBypass(() => loadHomeAnnouncementRows(org.orgId))).find((row) => row.id === one.id)?.title,
      'Holiday party!',
    )
    await assert.rejects(
      withBypass(() => saveHomeAnnouncementRow(org.orgId, '00000000-0000-4000-8000-000000000000', { title: 'X', startsOn: '2026-01-01' })),
      /not found/,
    )
    await withBypass(() => deleteHomeAnnouncementRow(org.orgId, two.id))
    assert.equal((await withBypass(() => loadHomeAnnouncementRows(org.orgId))).length, 1)
    // The shared Setup write path serves the entity (create/update/delete).
    const created = await withBypass(() => createSetupRecord(authz, 'home-announcements', {
      title: 'Via setup', audience: 'employees', startsOn: '2026-09-01',
    }))
    assert.equal(created.status, 200)
    const updated = await withBypass(() => updateSetupRecord(authz, 'home-announcements', {
      ...(created.body as Record<string, unknown>), title: 'Via setup!',
    }))
    assert.equal(updated.status, 200)
    const deleted = await withBypass(() => deleteSetupRecord(authz, 'home-announcements', (created.body as { id: string }).id))
    assert.equal(deleted.status, 200)
    // Refusals name the remedy.
    const bad = await withBypass(() => createSetupRecord(authz, 'home-announcements', { title: '', startsOn: '2026-01-01' }))
    assert.equal(bad.status, 400)
    // The registry gates the entity on its feature.
    assert.equal(SETUP_ENTITY_BY_KEY.get('home-announcements')?.featureKey, 'homeAnnouncements')
    // Feature fence: with the switch off the entity 404s instead of writing.
    await withBypass(() => db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,homeAnnouncements}', 'false'::jsonb, true)
       where id = ${org.orgId}`))
    const fenced = await withBypass(() => createSetupRecord(authz, 'home-announcements', {
      title: 'Fenced', startsOn: '2026-01-01',
    }))
    assert.equal(fenced.status, 404)
  } finally { await withBypass(() => dropScratchOrg(other.orgId)); await withBypass(() => dropScratchOrg(org.orgId)) }
})

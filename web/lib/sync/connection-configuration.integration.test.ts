import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export{}' }
  return next(specifier, context)
} })
const { db, withOrgContext } = await import('@openbooks/engine/platform/db')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/testing/fixtures')
const { getConnection } = await import('@openbooks/engine/sync/connection')
const { sql } = await import('drizzle-orm')
const { updateConnection } = await import('./connection-update')

test('native connection edits preserve identity, audit nested content choices and refuse unsupported or foreign writes', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const foreign = await createScratchOrg()
  try {
    const userId = await createScratchUser(org.orgId, 'Connection administrator', 'connection_admin')
    const id = randomUUID()
    const qboId = randomUUID()
    const original = { account: '1234567', host: 'https://1.1.1.1', baseCurrency: 'CAD', entityMappings: {version:1,entities:{},sourceOptions:{projectForemanField:'custentity_foreman'}} }
    await db.execute(sql`insert into connections (id, org_id, source, display_name, auth_kind, config) values
      (${id}, ${org.orgId}, 'netsuite', 'Source account', 'token', ${JSON.stringify(original)}::jsonb),
      (${qboId}, ${org.orgId}, 'qbo', 'OAuth account', 'oauth2', '{"environment":"sandbox","realmId":"callback-owned"}'::jsonb)`)
    const actor = { orgId: org.orgId, userId }
    const selection = { attachments: false, projectFinancials: true, crm: false, fixedAssets: true }
    const sourceOptions = { projectForemanField: 'custentity_foreman', timeTypeRecord: 'customrecord_time', timeTypeMultiplierField: 'custrecord_multiplier', projectStatuses: { Completed: 'closed' } }
    const edited = await withOrgContext(org.orgId, () => updateConnection(actor, id, { config: { entityMappings:{version:1,entities:{},sourceOptions}, syncOptions: selection } }))
    assert.equal(edited.status, 200)
    const saved = await getConnection(org.orgId, id)
    assert.deepEqual(saved?.config, { ...original, entityMappings:{version:1,entities:{},sourceOptions}, syncOptions: selection })
    const audit = await db.execute<{ actor_id: string; changes: { before: { config: unknown }; after: { config: unknown }; credentialsChanged: boolean } }>(sql`
      select actor_id, changes from audit_log where org_id=${org.orgId} and table_name='connections' and row_id=${id}`, 'objects')
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.actor_id, userId)
    assert.deepEqual(audit[0]!.changes.before.config, original)
    assert.deepEqual(audit[0]!.changes.after.config, saved!.config)
    assert.equal(audit[0]!.changes.credentialsChanged, false)

    const broken = await withOrgContext(org.orgId, () => updateConnection(actor, id, { config: { entityMappings:{version:1,entities:{},sourceOptions:{timeTypeMultiplierField:'custrecord_multiplier'}} } }))
    assert.equal(broken.status, 400)
    assert.match(String(broken.body.error), /requires timeTypeRecord/)
    assert.deepEqual((await getConnection(org.orgId, id))!.config, saved!.config)
    const isolated = await withOrgContext(foreign.orgId, () => updateConnection({ orgId: foreign.orgId, userId }, id, { displayName: 'Foreign edit' }))
    assert.equal(isolated.status, 404)
    assert.equal((await getConnection(org.orgId, id))!.displayName, 'Source account')

    const unsupported = await withOrgContext(org.orgId, () => updateConnection(actor, qboId, { config: { syncOptions: { crm: true } } }))
    assert.equal(unsupported.status, 400)
    assert.match(String(unsupported.body.error), /does not support crm/)
    const supportedDefaults = { attachments: true, projectFinancials: false, crm: false, fixedAssets: false }
    const oauth = await withOrgContext(org.orgId, () => updateConnection(actor, qboId, { config: { syncOptions: supportedDefaults } }))
    assert.equal(oauth.status, 200)
    assert.deepEqual((await getConnection(org.orgId, qboId))!.config, { environment: 'sandbox', realmId: 'callback-owned', syncOptions: supportedDefaults })
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id=${org.orgId} and table_name='connections'`, 'objects'))[0]!.count, 2, 'refused writes produce no configuration-change audit')
  } finally {
    await dropScratchOrg(foreign.orgId)
    await dropScratchOrg(org.orgId)
  }
})

test('the out-of-period date policy saves with an audited before and after and refuses unknown values', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const userId = await createScratchUser(org.orgId, 'Connection administrator', 'connection_admin')
    const id = randomUUID()
    await db.execute(sql`insert into connections (id, org_id, source, display_name, auth_kind, config) values
      (${id}, ${org.orgId}, 'qbo', 'OAuth account', 'oauth2', '{"environment":"sandbox"}'::jsonb)`)
    const actor = { orgId: org.orgId, userId }
    assert.equal((await getConnection(org.orgId, id))!.outOfPeriodDatePolicy, 'refuse')

    const saved = await withOrgContext(org.orgId, () => updateConnection(actor, id, { outOfPeriodDatePolicy: 'period_boundary' }))
    assert.equal(saved.status, 200)
    assert.equal((await getConnection(org.orgId, id))!.outOfPeriodDatePolicy, 'period_boundary')
    const audit = await db.execute<{ actor_id: string; changes: { before: { outOfPeriodDates: string }; after: { outOfPeriodDates: string } } }>(sql`
      select actor_id, changes from audit_log where org_id=${org.orgId} and table_name='connections' and row_id=${id}`, 'objects')
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.actor_id, userId)
    assert.equal(audit[0]!.changes.before.outOfPeriodDates, 'refuse')
    assert.equal(audit[0]!.changes.after.outOfPeriodDates, 'period_boundary')

    await assert.rejects(
      db.execute(sql`update connections set out_of_period_date_policy = 'nearest' where id = ${id}`),
      (error: unknown) => /connections_out_of_period_date_policy_check/.test(String((error as { cause?: unknown }).cause)),
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export{}' }
  return next(specifier, context)
} })
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { getConnection } = await import('@openbooks/engine/src/sync/connection.ts')
const { sql } = await import('drizzle-orm')
const { updateConnection } = await import('./connection-update')

test('native connection edits preserve identity, audit nested content choices and refuse unsupported or foreign writes', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const foreign = await createScratchOrg()
  try {
    const userId = await createScratchUser(org.orgId, 'Connection administrator', 'connection_admin')
    const id = randomUUID()
    const qboId = randomUUID()
    const original = { account: '1234567', host: 'https://1.1.1.1', baseCurrency: 'CAD', mappingJson: JSON.stringify({ projectForemanField: 'custentity_foreman' }) }
    await db.execute(sql`insert into connections (id, org_id, source, display_name, auth_kind, config) values
      (${id}, ${org.orgId}, 'netsuite', 'Source account', 'token', ${JSON.stringify(original)}::jsonb),
      (${qboId}, ${org.orgId}, 'qbo', 'OAuth account', 'oauth2', '{"environment":"sandbox","realmId":"callback-owned"}'::jsonb)`)
    const actor = { orgId: org.orgId, userId }
    const selection = { attachments: false, projectFinancials: true, crm: false, fixedAssets: true }
    const mappingJson = { projectForemanField: 'custentity_foreman', timeTypeRecord: 'customrecord_time', timeTypeMultiplierField: 'custrecord_multiplier', projectStatuses: { Completed: 'closed' } }
    const edited = await withOrgContext(org.orgId, () => updateConnection(actor, id, { config: { mappingJson, syncOptions: selection } }))
    assert.equal(edited.status, 200)
    const saved = await getConnection(org.orgId, id)
    assert.deepEqual(saved?.config, { ...original, mappingJson, syncOptions: selection })
    const audit = (await db.execute<{ actor_id: string; changes: { before: { config: unknown }; after: { config: unknown }; credentialsChanged: boolean } }>(sql`
      select actor_id, changes from audit_log where org_id=${org.orgId} and table_name='connections' and row_id=${id}`)).rows
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.actor_id, userId)
    assert.deepEqual(audit[0]!.changes.before.config, original)
    assert.deepEqual(audit[0]!.changes.after.config, saved!.config)
    assert.equal(audit[0]!.changes.credentialsChanged, false)

    const broken = await withOrgContext(org.orgId, () => updateConnection(actor, id, { config: { mappingJson: { timeTypeMultiplierField: 'custrecord_multiplier' } } }))
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
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id=${org.orgId} and table_name='connections'`)).rows[0]!.count, 2, 'refused writes produce no configuration-change audit')
  } finally {
    await dropScratchOrg(foreign.orgId)
    await dropScratchOrg(org.orgId)
  }
})

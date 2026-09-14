import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { installTestExtension, disableTestExtension } = await import('@openbooks/engine/src/test-extension-packages.ts')
const { loadExtensionSettingRows, saveExtensionSettingRow, extensionSettingDrawerEntity } = await import('./extension-settings.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

test('setup adapter edits declared module values with tenant isolation and preserves history on disable', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const other = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  try {
    await withBypass(() => installTestExtension({ orgId: org.orgId, actorId: actor, manifest: {
      key: 'setup-proof', name: 'Setup proof', version: '1.0.0', permissions: ['admin.setup.manage'], contributions: [
        { kind: 'setting', key: 'caption', label: 'Caption', valueType: 'string', defaultValue: 'Before' },
        { kind: 'setting', key: 'visible', label: 'Visible', valueType: 'boolean', defaultValue: false },
      ],
    }}))
    const rows = await withBypass(() => loadExtensionSettingRows(org.orgId))
    assert.equal(rows.length, 2)
    const bool = rows.find(row => row.setting_key === 'visible')!
    assert.equal(bool.value, false)
    const descriptor = extensionSettingDrawerEntity(SETUP_ENTITY_BY_KEY.get('extension-settings')!, bool)
    assert.equal(descriptor.fields.find(field => field.key === 'value')!.kind, 'boolean')
    assert.equal(descriptor.allowCreate, false)
    assert.equal(descriptor.allowDelete, false)
    await assert.rejects(withBypass(() => saveExtensionSettingRow(other.orgId, actor, ['*'], { id: rows[0]!.id, value: 'Outside', reason: 'Forbidden' })), /not found/)
    await withBypass(() => saveExtensionSettingRow(org.orgId, actor, ['admin.setup.manage'], { id: 'setup-proof:caption', value: 'After', reason: 'Improve caption', expectedValue: 'Before', expectedExtensionVersionId: rows[0]!.extension_version_id }))
    const updated = await withBypass(() => loadExtensionSettingRows(org.orgId))
    assert.equal(updated.find(row => row.setting_key === 'caption')!.value, 'After')
    await assert.rejects(withBypass(() => saveExtensionSettingRow(org.orgId, actor, ['admin.setup.manage'], { id: 'setup-proof:caption', value: 'Stale', reason: 'Stale editor', expectedValue: 'Before', expectedExtensionVersionId: rows[0]!.extension_version_id })), /changed|reload|stale/i)
    await withBypass(() => disableTestExtension({ orgId: org.orgId, actorId: actor, key: 'setup-proof' }))
    assert.deepEqual(await withBypass(() => loadExtensionSettingRows(org.orgId)), [])
    const preserved = await withBypass(() => db.execute(sql`select settings->'extensionSettings'->'setup-proof'->>'caption' as value from orgs where id = ${org.orgId}`))
    assert.equal(preserved.rows[0]!.value, 'After')
  } finally { await withBypass(() => dropScratchOrg(other.orgId)); await withBypass(() => dropScratchOrg(org.orgId)) }
})

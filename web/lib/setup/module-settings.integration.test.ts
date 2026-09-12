import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { uninstallModule } = await import('@openbooks/engine/src/modules/installer.ts')
const { requestModuleInstallApproval, decideModuleApproval } = await import('@openbooks/engine/src/modules/lifecycle.ts')
const { loadModuleSettingRows, saveModuleSettingRow, moduleSettingDrawerEntity } = await import('./module-settings.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

test('setup adapter edits declared module values with tenant isolation and preserves history on disable', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const other = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  const approver = await withBypass(() => createScratchUser(org.orgId, 'Module Approver', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  try {
    const staged = await withBypass(() => requestModuleInstallApproval({ orgId: org.orgId, requesterId: actor, installerEffectivePermissions: ['*'], assignees: [{ type: 'user', userId: approver }], manifest: {
      key: 'setup-proof', name: 'Setup proof', version: '1.0.0', permissions: ['admin.setup.manage'], contributions: [
        { kind: 'setting', key: 'caption', label: 'Caption', valueType: 'string', defaultValue: 'Before' },
        { kind: 'setting', key: 'visible', label: 'Visible', valueType: 'boolean', defaultValue: false },
      ],
    }}))
    await withBypass(() => decideModuleApproval({ gateId: staged.gateIds[0]!, userId: approver, decision: 'approved', signature: 'Module Approver', approverEffectivePermissions: ['*'] }))
    const rows = await withBypass(() => loadModuleSettingRows(org.orgId))
    assert.equal(rows.length, 2)
    const bool = rows.find(row => row.setting_key === 'visible')!
    assert.equal(bool.value, false)
    const descriptor = moduleSettingDrawerEntity(SETUP_ENTITY_BY_KEY.get('module-settings')!, bool)
    assert.equal(descriptor.fields.find(field => field.key === 'value')!.kind, 'boolean')
    assert.equal(descriptor.allowCreate, false)
    assert.equal(descriptor.allowDelete, false)
    await assert.rejects(withBypass(() => saveModuleSettingRow(other.orgId, actor, ['*'], { id: rows[0]!.id, value: 'Outside', reason: 'Forbidden' })), /not found/)
    await withBypass(() => saveModuleSettingRow(org.orgId, actor, ['admin.setup.manage'], { id: 'setup-proof:caption', value: 'After', reason: 'Improve caption', expectedValue: 'Before', expectedModuleVersionId: rows[0]!.module_version_id }))
    const updated = await withBypass(() => loadModuleSettingRows(org.orgId))
    assert.equal(updated.find(row => row.setting_key === 'caption')!.value, 'After')
    await assert.rejects(withBypass(() => saveModuleSettingRow(org.orgId, actor, ['admin.setup.manage'], { id: 'setup-proof:caption', value: 'Stale', reason: 'Stale editor', expectedValue: 'Before', expectedModuleVersionId: rows[0]!.module_version_id })), /changed|reload|stale/i)
    await withBypass(() => uninstallModule({ orgId: org.orgId, actorId: actor, key: 'setup-proof' }))
    assert.deepEqual(await withBypass(() => loadModuleSettingRows(org.orgId)), [])
    const preserved = await withBypass(() => db.execute(sql`select settings->'moduleSettings'->'setup-proof'->>'caption' as value from orgs where id = ${org.orgId}`))
    assert.equal(preserved.rows[0]!.value, 'After')
  } finally { await withBypass(() => dropScratchOrg(other.orgId)); await withBypass(() => dropScratchOrg(org.orgId)) }
})

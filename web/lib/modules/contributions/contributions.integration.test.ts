import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNavContribution } from './nav'
import { parseSettingContribution } from './settings'
import { parsePermissionContribution } from './permissions'
import { validateModuleInstallManifest } from '@openbooks/engine/src/modules/installer.ts'
import { parseModuleManifest } from '../manifest'

// Persistence, signature, withdrawal and effective-date evidence are exercised
// against PostgreSQL in engine/src/modules/projections.integration.test.ts.
test('web contribution parsers and engine persistence share exactly the same payload validation', () => {
  const declarations = [
    { kind: 'nav', href: '/contribution-example', label: 'Example', group: 'insights' },
    { kind: 'setting', key: 'caption', label: 'Caption', valueType: 'string', defaultValue: 'Example' },
    { kind: 'permission', key: 'example.read', label: 'Read example' },
  ]
  const manifest = { key: 'example-module', name: 'Example module', version: '1.0.0', permissions: ['admin.customization.manage', 'admin.setup.manage', 'admin.roles.manage'], contributions: declarations }
  const parsed = parseModuleManifest(manifest)
  assert.equal(parsed.ok, true)
  assert.deepEqual(validateModuleInstallManifest(manifest), parsed.manifest)
  assert.equal(parseNavContribution(declarations[0]).ok, true)
  assert.equal(parseSettingContribution(declarations[1]).ok, true)
  assert.equal(parsePermissionContribution(declarations[2]).ok, true)
})

test('projection schemas reject unknown groups, native navigation, wildcard declarations and non-JSON configuration', () => {
  assert.equal(parseNavContribution({ kind: 'nav', href: '/contribution-example', label: 'Example', group: 'invented' }).ok, false)
  assert.equal(parseNavContribution({ kind: 'nav', href: '/reports', label: 'Example', group: 'insights' }).ok, false)
  assert.equal(parsePermissionContribution({ kind: 'permission', key: 'example.*', label: 'Example' }).ok, false)
  for (const value of [NaN, Infinity, new Date(), { missing: undefined }]) {
    assert.equal(parseSettingContribution({ kind: 'setting', key: 'value', label: 'Value', valueType: 'json', defaultValue: value }).ok, false)
  }
})

test('settings cannot mint feature switches or shadow authoritative feature keys', () => {
  for (const key of ['projects', 'job_costing_enabled', 'field_tickets', 'features', 'enable_feature']) {
    assert.equal(parseSettingContribution({ kind: 'setting', key, label: 'Feature', valueType: 'boolean', defaultValue: true }).ok, false)
  }
  assert.equal(parseSettingContribution({ kind: 'setting', key: 'caption', label: 'Caption', valueType: 'boolean', featureGate: true }).ok, false)
})

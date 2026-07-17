import assert from 'node:assert/strict'
import test from 'node:test'
import { NAV_GROUPS, NAV_MODULES, defaultNavConfig } from './registry'

test('default navigation is a complete version-two workspace configuration', () => {
  const config = defaultNavConfig()
  assert.equal(config.version, 2)
  assert.deepEqual(
    config.groups.map((group) => group.id),
    NAV_GROUPS.map((group) => group.key),
  )
  assert.deepEqual(
    config.groups.flatMap((group) => group.items).map((item) => (item.kind === 'module' ? item.moduleKey : '')),
    NAV_MODULES.map((module) => module.key),
  )
})

test('default mobile navigation pins exactly four high-frequency destinations', () => {
  const pinned = defaultNavConfig()
    .groups.flatMap((group) => group.items)
    .filter((item) => item.mobile)
    .map((item) => (item.kind === 'module' ? item.moduleKey : ''))
  assert.deepEqual(pinned, ['dashboard', 'approvals', 'ar', 'ap'])
})

test('every module belongs to a declared workspace and has a unique stable key', () => {
  const groupKeys = new Set(NAV_GROUPS.map((group) => group.key))
  assert.equal(new Set(NAV_MODULES.map((module) => module.key)).size, NAV_MODULES.length)
  for (const module of NAV_MODULES) assert.ok(groupKeys.has(module.group), module.key)
})

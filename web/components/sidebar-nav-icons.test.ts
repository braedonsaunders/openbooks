import assert from 'node:assert/strict'
import test from 'node:test'
import { NAV_MODULES } from '@openbooks/engine/src/navigation/nav-registry.ts'
import { ICON_KEYS } from './sidebar-nav'

test('every menu entry names an icon the sidebar can draw', () => {
  const known = new Set(ICON_KEYS)
  const unknown = NAV_MODULES.filter((module) => !known.has(module.iconKey)).map((module) => `${module.key}: ${module.iconKey}`)
  assert.deepEqual(unknown, [], 'an unknown key silently renders the fallback icon')
})

test('entries listed together in one menu section carry distinct icons', () => {
  const seen = new Map<string, string>()
  const repeats: string[] = []
  for (const module of NAV_MODULES) {
    const slot = `${module.group}/${module.subgroup ?? ''}/${module.iconKey}`
    const first = seen.get(slot)
    if (first) repeats.push(`${first} and ${module.key} share ${module.iconKey}`)
    else seen.set(slot, module.key)
  }
  assert.deepEqual(repeats, [])
})

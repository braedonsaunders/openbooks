import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assetWorkspaceTabs } from './tabs'

test('asset workspace tabs use one route set across register, tax, and equipment', () => {
  const tabs = assetWorkspaceTabs({
    active: 'equipment',
    registerLabel: 'Register',
    taxDepreciationLabel: 'Tax depreciation',
    equipmentLabel: 'Equipment',
    showFixedAssets: true,
    showEquipment: true,
  })

  assert.deepEqual(tabs.map(({ href }) => href), [
    '/assets',
    '/assets?tab=tax-depreciation',
    '/assets/equipment',
  ])
  assert.deepEqual(tabs.map(({ active }) => active), [false, false, true])
})

test('asset pages render the shared header subtab strip and no local link rows', () => {
  const assets = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
  const equipment = readFileSync(new URL('./equipment/view.ts', import.meta.url), 'utf8')

  assert.match(assets, /widget\('module-home-tabs', \{ tabs: data\.tabs \}\)/)
  assert.match(equipment, /widget\('module-home-tabs', \{ tabs: data\.tabs \}\)/)
  assert.doesNotMatch(assets, /widgetBlock\('assets-tabs'/)
  assert.doesNotMatch(assets, /widgetBlock\('assets-equipment-link'/)
  assert.doesNotMatch(equipment, /widgetBlock\('equipment-header-links'/)
})

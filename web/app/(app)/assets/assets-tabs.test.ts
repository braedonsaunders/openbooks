import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { assetWorkspaceTabs } from './tabs'
import type { AssetsData } from './view'
import type { EquipmentData } from './equipment/view'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { assetsSpec } = await import('./view')
const { equipmentSpec } = await import('./equipment/view')

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

function widgetsNamed(node: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((item) => widgetsNamed(item, name))
  if (typeof node !== 'object' || node === null) return []
  const object = node as Record<string, unknown>
  const own = object.widget === name ? [object] : []
  return [...own, ...Object.values(object).flatMap((child) => widgetsNamed(child, name))]
}

function assetsFixture(tabs: AssetsData['tabs']): AssetsData {
  return {
    title: 'Fixed Assets', description: 'The fixed asset register', tabs,
    onRegister: true, onTax: false, docLabel: 'Documentation', showActions: false,
    books: [], candidates: [], periods: [], equipmentLabel: 'Equipment', currentParams: {},
    canManage: false, canRun: false, canConfigure: false, regimes: [], defaultTaxYear: 0,
    showNewRedirect: false, drawer: null,
  }
}

function equipmentFixture(tabs: EquipmentData['tabs']): EquipmentData {
  return {
    title: 'Equipment', description: 'The equipment register', currentParams: {},
    canManage: false, kpis: [], tabs, fixedAssetsLabel: 'Fixed assets',
    taxDepreciationLabel: 'Tax depreciation', documentationLabel: 'Documentation',
    showFixedAssetsLinks: true, drawer: null,
  }
}

test('asset register and equipment specs expose the same shared route switcher', () => {
  const tabs = [
    { key: 'register', href: '/assets', label: 'Register', active: true },
    { key: 'tax-depreciation', href: '/assets?tab=tax-depreciation', label: 'Tax depreciation', active: false },
    { key: 'equipment', href: '/assets/equipment', label: 'Equipment', active: false },
  ]
  const assets = assetsSpec(assetsFixture(tabs))
  const equipment = equipmentSpec(equipmentFixture(tabs))
  const assetSwitcher = widgetsNamed(assets, 'module-home-tabs')
  const equipmentSwitcher = widgetsNamed(equipment, 'module-home-tabs')

  assert.equal(assetSwitcher.length, 1, 'fixed assets has one shared route switcher')
  assert.equal(equipmentSwitcher.length, 1, 'equipment has one shared route switcher')
  assert.deepEqual((assetSwitcher[0]?.props as { tabs?: unknown })?.tabs, tabs)
  assert.deepEqual((equipmentSwitcher[0]?.props as { tabs?: unknown })?.tabs, tabs)
  assert.equal(widgetsNamed(assets, 'assets-tabs').length, 0)
  assert.equal(widgetsNamed(assets, 'assets-equipment-link').length, 0)
  assert.equal(widgetsNamed(equipment, 'equipment-header-links').length, 0)
})

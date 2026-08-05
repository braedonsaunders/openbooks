import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { getArticle } from './docs/index'
import { MODULE_BY_KEY } from './nav/registry'

const source = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('property management is a gated module enabled by its industry preset', () => {
  const featureRegistry = source('./features.ts')
  assert.match(
    featureRegistry,
    /key: 'propertyManagement'.*navModules: \['property-management'\]/,
  )

  const industryRegistry = source('./industries.ts')
  const propertyPreset = industryRegistry.match(
    /key: 'property_management',[\s\S]*?(?=\n  \/\/ ── Non-Profit)/,
  )?.[0]
  assert.match(propertyPreset ?? '', /propertyManagement: true/)
  assert.match(propertyPreset ?? '', /name: 'Security Deposits Held'/)
  assert.match(propertyPreset ?? '', /name: 'Rental Income'/)

  assert.deepEqual(MODULE_BY_KEY.get('property-management'), {
    key: 'property-management',
    href: '/property-management',
    label: 'Property Management',
    iconKey: 'building',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'ar.read',
    featureKey: 'propertyManagement',
  })
})

test('property management has feature-switch, navigation, scheduler, and help wiring', () => {
  const adminMessages = JSON.parse(source('../messages/en/admin.json'))
  const navMessages = JSON.parse(source('../messages/en/nav.json'))
  assert.equal(adminMessages.features.propertyManagement.title, 'Property management')
  assert.equal(navMessages.modules['property-management'], 'Property Management')

  const featureWorkspace = source('../app/(app)/admin/setup/features/FeaturesWorkspace.tsx')
  assert.match(featureWorkspace, /propertyManagement: Building2/)

  const scheduler = source('../../engine/src/scheduler.ts')
  assert.match(scheduler, /runDuePropertyBilling/)

  const article = getArticle('property-management')
  assert.equal(article?.title, 'Property Management')
  assert.match(article?.body ?? '', /security deposits/i)
  assert.match(article?.body ?? '', /CAM reconciliation/i)
})

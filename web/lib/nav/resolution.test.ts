import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createTranslator } from 'next-intl'
import { registerHooks } from 'node:module'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { FEATURES } from '@openbooks/engine/src/organization/feature-registry.ts'
import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts'
import { defaultNavConfig, type OrgNavConfig } from './registry'
import messages from '../../messages/en'

const translator = createTranslator({ locale: 'en', messages })
// Translations need the Next request store; use the real catalog and translator.
const translateKey = Symbol.for('openbooks.navigation.translator')
;(globalThis as unknown as Record<symbol, unknown>)[translateKey] = translator
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent("export async function getTranslations(ns) { return key => globalThis[Symbol.for('openbooks.navigation.translator')](ns + '.' + key) }") }
    return next(specifier, context)
  },
})
const { resolveNav } = await import('./resolve')
const { resolveLocalNavigation } = await import('./local')
const dialect = new PgDialect()
let config: OrgNavConfig
let features: Record<string, boolean>
let contributions: unknown[] = []
const execute = db.execute

function reset() {
  config = defaultNavConfig()
  features = Object.fromEntries(FEATURES.map((feature) => [feature.key, true]))
  features.multiSubsidiary = false
  features.multiCurrency = false
  contributions = []
}

// Script only database rows. Feature dependencies, metadata, permission checks,
// URL matching, preferences, and installed-contribution validation remain real.
db.execute = (async (query) => {
  const compiled = dialect.sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0])
  const text = compiled.sql
  assert.ok(compiled.params.includes('company-one'), `organization-scoped query: ${text}`)
  if (text.includes('from org_nav_configs')) return { rows: [{ config, updated_at: new Date('2026-09-30T12:00:00Z') }] }
  if (text.includes("settings->'features' as f")) return { rows: [{ f: features }] }
  if (text.includes('from apps m')) return { rows: features.apps ? [{ extensionKey: 'team-tools', extensionId: 'extension', versionId: 'version', manifest: { contributions } }] : [] }
  if (text.includes('from apps a') || text.includes('from custom_record_types')) return { rows: [] }
  throw new Error(`Unexpected navigation query: ${text}`)
}) as typeof db.execute

test.after(() => { db.execute = execute })

for (const hrm of [false, true]) for (const payroll of [false, true]) {
  test(`People ownership remains coherent with HR ${hrm} and Payroll ${payroll}`, async () => {
    reset(); features.hrm = hrm; features.payroll = payroll
    const groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
    const employeeOwner = groups.find((group) => group.items.some((item) => item.href === '/entities/employees'))!
    assert.equal(employeeOwner.id, hrm ? 'hrm' : 'operations')
    assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href === '/hrm'), 'HR homepage is the parent destination')
    const people = groups.find((group) => group.id === 'hrm')
    assert.equal(people?.groupHref, hrm ? '/hrm' : undefined)
    const payrollOwner = groups.find((group) => group.items.some((item) => item.href === '/payroll/runs'))
    assert.equal(payrollOwner?.id, payroll ? hrm ? 'hrm' : 'operations' : undefined)
    const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set(['*']) } as Parameters<typeof resolveLocalNavigation>[0])
    assert.equal(local.groups.some((group) => group.some((tab) => tab.href === '/payroll/runs')), payroll)
    assert.equal(local.groups.some((group) => group.some((tab) => tab.href === '/hrm/positions')), hrm)
  })
}

test('hidden and renamed destinations share one snapshot while local order stays configurable', async () => {
  reset()
  config.groups.find((group) => group.id === 'hrm')!.items.forEach((item) => {
    if (item.kind === 'module' && item.moduleKey === 'payroll-runs') item.label = 'Process wages'
    if (item.kind === 'module' && item.moduleKey === 'payroll-anomalies') item.hidden = true
  })
  config.localNavigation = { payroll: { items: [{ href: '/payroll/runs' }, { href: '/payroll', hidden: true }] } }
  const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set(['*']) } as Parameters<typeof resolveLocalNavigation>[0])
  const tabs = local.groups.find((group) => group.some((tab) => tab.href === '/payroll/runs'))!
  assert.equal(tabs[0]!.label, 'Process wages')
  assert.ok(!tabs.some((tab) => tab.href === '/payroll/anomalies' || tab.href === '/payroll'))
  const groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.equal(groups.flatMap((group) => group.items).find((item) => item.href === '/payroll/runs')!.label, 'Process wages')
})

test('custom URLs and local choices cannot grant access around permission or feature gates', async () => {
  reset()
  config.groups[0]!.items.push({ kind: 'link', href: '/payroll/runs?status=posted#history', label: 'Wages' })
  config.localNavigation = { payroll: { items: [{ href: '/payroll/runs', label: 'Secret wages' }] } }
  const permissions = new Set(['parties.read'])
  const allowed = (key: string | undefined) => !key || permissionSetCovers(permissions, key)
  const groups = await resolveNav('company-one', allowed, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href.startsWith('/payroll')))
  const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions } as Parameters<typeof resolveLocalNavigation>[0])
  assert.ok(!local.groups.some((group) => group.some((tab) => tab.href.startsWith('/payroll'))))
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href === '/hrm/org-chart'))
  assert.ok(!local.groups.flat().some((tab) => tab.href === '/hrm/org-chart'))
  for (const permission of ['hrm.employment.read', 'hrm.self.read']) {
    const authorized = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set([permission]) } as Parameters<typeof resolveLocalNavigation>[0])
    assert.ok(authorized.groups.flat().some((tab) => tab.href === '/hrm/org-chart'), permission)
  }
})

test('checklist templates are discoverable beside checklists only with the management grant', async () => {
  reset()
  const authz = { user: { orgId: 'company-one' }, permissions: new Set(['parties.read', 'hrm.process.read']) } as Parameters<typeof resolveLocalNavigation>[0]
  let local = await resolveLocalNavigation(authz)
  assert.ok(local.groups.flat().some((tab) => tab.href === '/hrm/processes'))
  assert.ok(!local.groups.flat().some((tab) => tab.href === '/hrm/processes/templates'))
  authz.permissions.add('hrm.process.manage')
  local = await resolveLocalNavigation(authz)
  const people = local.groups.find((group) => group.some((tab) => tab.href === '/hrm/processes'))!
  assert.equal(people.findIndex((tab) => tab.href === '/hrm/processes/templates'), people.findIndex((tab) => tab.href === '/hrm/processes') + 1)
  assert.equal(people.find((tab) => tab.href === '/hrm/processes/templates')!.label, 'Checklist templates')
  const groups = await resolveNav('company-one', (key) => !key || permissionSetCovers(authz.permissions, key), [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(groups.flatMap((group) => group.items).some((item) => item.href === '/hrm/processes/templates' && item.subgroup === 'Workforce'))
})

test('installed local contributions require a placed shortcut and their native permission', async () => {
  reset()
  contributions = [{ kind: 'nav', href: '/apps/team-tools', label: 'Team planning', group: 'hrm', requiredPermission: 'apps.use', workspaceKey: 'hrm-people' }]
  const authz = { user: { orgId: 'company-one' }, permissions: new Set(['*']) } as Parameters<typeof resolveLocalNavigation>[0]
  assert.ok(!(await resolveLocalNavigation(authz)).groups.flat().some((tab) => tab.href.startsWith('/apps/team-tools')))
  config.groups[0]!.items.push({ kind: 'link', href: '/apps/team-tools', label: 'Our planning', extensionKey: 'team-tools', requiredPermission: 'apps.use' })
  assert.equal((await resolveLocalNavigation(authz)).groups.flat().find((tab) => tab.href.startsWith('/apps/team-tools'))!.label, 'Our planning')
  features.apps = false
  assert.ok(!(await resolveLocalNavigation(authz)).groups.flat().some((tab) => tab.href.startsWith('/apps/team-tools')))
})


test('Talent includes recruitment and every authorized performance view without a Cycles umbrella', async () => {
  reset()
  let groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  const people = groups.find((group) => group.id === 'hrm')!
  const destinations = ['/hrm/positions','/hrm/recruiting','/hrm/recruiting?tab=interviews','/hrm/recruiting?tab=offers','/hrm/recruiting?tab=postings','/hrm/recruiting?tab=pools','/hrm/performance','/hrm/performance?tab=calibration','/hrm/performance?tab=talent','/hrm/performance?tab=retention','/hrm/surveys','/hrm/performance?tab=settings']
  for (const href of destinations) assert.ok(people.items.some((item) => item.href === href && item.subgroup === 'Talent'), href)
  assert.equal(people.items.find((item) => item.href === '/hrm/performance')!.label, 'Performance')
  const permissions = new Set(['hrm.self.read'])
  config.groups[0]!.items.push({kind:'link',href:'/hrm/performance?tab=settings',label:'Settings shortcut'})
  groups = await resolveNav('company-one', (key) => !key || permissionSetCovers(permissions,key), [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href === '/hrm/performance?tab=settings' || item.href === '/hrm/performance?tab=calibration'))
})

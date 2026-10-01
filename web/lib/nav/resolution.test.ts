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
  for (const permission of ['hrm.org_chart.read', 'hrm.employment.read', 'hrm.self.read']) {
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


test('Talent exposes two workspaces while detailed views remain in authorized local navigation', async () => {
  reset()
  const groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  const people = groups.find((group) => group.id === 'hrm')!
  assert.deepEqual(people.items.filter((item) => item.subgroup === 'Talent').map((item) => [item.href, item.label]), [
    ['/hrm/recruiting', 'Recruiting'], ['/hrm/performance', 'Performance'],
  ])
  const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set(['*']) } as Parameters<typeof resolveLocalNavigation>[0])
  const recruiting = local.groups.find((group) => group.some((tab) => tab.href === '/hrm/recruiting'))!
  assert.deepEqual(recruiting.map((tab) => tab.href), ['/hrm/recruiting', '/hrm/positions', ...['interviews', 'offers', 'postings', 'pools'].map((tab) => `/hrm/recruiting?tab=${tab}`)])
  const performance = local.groups.find((group) => group.some((tab) => tab.href === '/hrm/performance'))!
  assert.deepEqual(performance.map((tab) => tab.href), ['/hrm/performance', '/hrm/performance/templates', '/hrm/performance?tab=calibration', '/hrm/performance?tab=talent', '/hrm/performance?tab=succession', '/hrm/performance?tab=retention', '/hrm/surveys'])
  assert.equal(performance[0]!.label, 'Cycles')
})

test('explicit Talent shortcuts survive compact defaults and still enforce access', async () => {
  reset()
  const item = config.groups.find((group) => group.id === 'hrm')!.items.find((entry) => entry.kind === 'module' && entry.moduleKey === 'hrm-performance-calibration')!
  assert.equal(item.kind, 'module')
  if (item.kind !== 'module') throw new Error('Expected a native destination')
  item.placement = 'custom'
  item.label = 'Review calibration'
  let groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(groups.flatMap((group) => group.items).some((entry) => entry.href === '/hrm/performance?tab=calibration' && entry.label === 'Review calibration'))
  const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set(['*']) } as Parameters<typeof resolveLocalNavigation>[0])
  assert.ok(local.groups.flat().some((tab) => tab.href === '/hrm/performance?tab=calibration' && tab.label === 'Review calibration'))
  const permissions = new Set(['hrm.self.read'])
  config.groups[0]!.items.push({kind:'link',href:'/hrm/performance?tab=settings',label:'Settings shortcut'})
  groups = await resolveNav('company-one', (key) => !key || permissionSetCovers(permissions,key), [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(!groups.flatMap((group) => group.items).some((entry) => entry.href === '/hrm/performance?tab=settings' || entry.href === '/hrm/performance?tab=calibration'))
  features.hrmRecruiting = false
  groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  assert.ok(!groups.flatMap((group) => group.items).some((entry) => entry.href.startsWith('/hrm/recruiting')))
})

test('independent Talent destinations remain discoverable when their parent workspace is unavailable', async () => {
  reset()
  features.hrmRecruiting = false
  features.hrmPerformance = false
  let groups = await resolveNav('company-one', () => true, [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  let talent = groups.flatMap((group) => group.items).filter((item) => item.subgroup === 'Talent')
  assert.deepEqual(talent.map((item) => item.href), ['/hrm/positions', '/hrm/surveys'])
  reset()
  const permissions = new Set(['hrm.position.read'])
  groups = await resolveNav('company-one', (key) => !key || permissionSetCovers(permissions, key), [], (key) => translator(`nav.${key}` as never), (key) => translator.has(`nav.${key}` as never))
  talent = groups.flatMap((group) => group.items).filter((item) => item.subgroup === 'Talent')
  assert.ok(talent.some((item) => item.href === '/hrm/positions'))
  assert.ok(!talent.some((item) => item.href === '/hrm/recruiting'))
})


test('Enrollment windows are accessible within Enrollments without a separate menu or local tab', async () => {
  reset()
  const translate = (key: string) => translator(`nav.${key}` as never)
  const has = (key: string) => translator.has(`nav.${key}` as never)
  const windowsHref = '/hrm/benefits?view=windows'
  let groups = await resolveNav('company-one', () => true, [], translate, has)
  const benefits = groups.flatMap((group) => group.items).filter((item) => item.subgroup === 'Benefits')
  assert.ok(benefits.some((item) => item.href === '/hrm/benefits?view=enrolments'))
  assert.ok(!benefits.some((item) => item.href === windowsHref))
  const local = await resolveLocalNavigation({ user: { orgId: 'company-one' }, permissions: new Set(['hrm.benefits.read']) } as Parameters<typeof resolveLocalNavigation>[0])
  assert.ok(!local.groups.flat().some((tab) => tab.href === windowsHref), 'windows are managed from enrollment instead of a separate page tab')
  const permissions = new Set(['hrm.self.read'])
  groups = await resolveNav('company-one', (key) => !key || permissionSetCovers(permissions, key), [], translate, has)
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href.startsWith('/hrm/benefits')), 'shortcuts cannot bypass authorization')
  features.hrm = false
  groups = await resolveNav('company-one', () => true, [], translate, has)
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.href.startsWith('/hrm/benefits')), 'shortcuts cannot bypass the HR feature')
})

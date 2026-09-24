import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const testStateKey = Symbol.for('openbooks.timesheets-view-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[testStateKey] = state

const mockAuthz = `
  import { subsidiaryScopeAllows } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
  export { subsidiaryScopeAllows }
  const state = globalThis[Symbol.for('openbooks.timesheets-view-scope-test')]
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`
const mockIntl = `export async function getTranslations() { return key => key }`
const mockFeatures = `export async function isFeatureEnabled() { return false }`
const mockFeatureGate = `export async function requireFeatureEnabled() {}`
const mockCustomFields = `export async function loadFieldDefs() { return [] }`
const mockTimePolicy = `export async function loadTimePolicy() { return { requireApproval: true } }`
const mockHrmRails = `export async function loadOpenFlagsForWeek() { return [] } export async function approvalFlags() { return [] }`

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'mock:timesheets-scope-intl' }
    if (specifier === '../../../lib/authz') return { shortCircuit: true, url: 'mock:timesheets-scope-authz' }
    if (specifier === '../../../lib/features') return { shortCircuit: true, url: 'mock:timesheets-scope-features' }
    if (specifier === '../../../lib/feature-gates') return { shortCircuit: true, url: 'mock:timesheets-scope-feature-gate' }
    if (specifier === '../../../lib/custom-fields') return { shortCircuit: true, url: 'mock:timesheets-scope-custom-fields' }
    if (specifier === '../../../lib/time-policy') return { shortCircuit: true, url: 'mock:timesheets-scope-time-policy' }
    if (specifier === '../../../lib/hrm/ai-rails') return { shortCircuit: true, url: 'mock:timesheets-scope-hrm-rails' }
    if (context.parentURL?.startsWith('mock:')) return next(specifier, { ...context, parentURL: import.meta.url })
    return next(specifier, context)
  },
  load(url, context, next) {
    const sources: Record<string, string> = {
      'mock:timesheets-scope-authz': mockAuthz,
      'mock:timesheets-scope-intl': mockIntl,
      'mock:timesheets-scope-features': mockFeatures,
      'mock:timesheets-scope-feature-gate': mockFeatureGate,
      'mock:timesheets-scope-custom-fields': mockCustomFields,
      'mock:timesheets-scope-time-policy': mockTimePolicy,
      'mock:timesheets-scope-hrm-rails': mockHrmRails,
    }
    if (sources[url]) return { format: 'module', source: sources[url], shortCircuit: true }
    return next(url, context)
  },
})

const { loadTimesheets } = await import('./view.ts') as typeof import('./view.ts')
hooks.deregister()
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')

async function addEmployee(orgId: string, name: string, subsidiaryId: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active)
    values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true)
  `)
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active)
    values (${orgId}, ${id}, '2026-01-01', true)
  `)
  return id
}

async function addProject(orgId: string, name: string, subsidiaryId: string): Promise<void> {
  await db.execute(sql`
    insert into projects (org_id, subsidiary_id, code, name, is_active, status, custom)
    values (${orgId}, ${subsidiaryId}, ${randomUUID()}, ${name}, true, 'active', '{}'::jsonb)
  `)
}

async function addDepartment(orgId: string, name: string, subsidiaryId: string | null): Promise<void> {
  await db.execute(sql`
    insert into departments (org_id, subsidiary_id, code, name, is_active, custom)
    values (${orgId}, ${subsidiaryId}, ${randomUUID()}, ${name}, true, '{}'::jsonb)
  `)
}

test('timesheet page and drawer stay within the caller subsidiary scope', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const branchId = randomUUID()
  const visibleEmployeeName = `Visible employee ${randomUUID()}`
  const hiddenEmployeeName = `Hidden employee ${randomUUID()}`
  const visibleProject = `Visible project ${randomUUID()}`
  const hiddenProject = `Hidden project ${randomUUID()}`
  const visibleDepartment = `Visible department ${randomUUID()}`
  const hiddenDepartment = `Hidden department ${randomUUID()}`
  const orgWideDepartment = `Org-wide department ${randomUUID()}`
  try {
    const employeeIds = await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Timesheet Scope Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      const visibleEmployee = await addEmployee(org.orgId, visibleEmployeeName, org.subsidiaryId)
      const hiddenEmployee = await addEmployee(org.orgId, hiddenEmployeeName, branchId)
      await addProject(org.orgId, visibleProject, org.subsidiaryId)
      await addProject(org.orgId, hiddenProject, branchId)
      await addDepartment(org.orgId, visibleDepartment, org.subsidiaryId)
      await addDepartment(org.orgId, hiddenDepartment, branchId)
      await addDepartment(org.orgId, orgWideDepartment, null)
      return { visibleEmployee, hiddenEmployee }
    })
    const { visibleEmployee, hiddenEmployee } = employeeIds

    state.authz = {
      user: { id: randomUUID(), orgId: org.orgId },
      permissions: new Set(['time.read']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    await withOrgContext(org.orgId, async () => {
      const list = await loadTimesheets({})
      assert.ok(list.newButton.href.startsWith(`/timesheets?timesheet=${visibleEmployee}:`), 'the fallback new-week target is an in-scope employee')
      assert.ok(!list.newButton.href.includes(hiddenEmployee), 'the fallback never selects an employee in another subsidiary')

      const blocked = await loadTimesheets({ timesheet: `${hiddenEmployee}:2026-09-20` })
      assert.equal(blocked.drawer, null, 'a URL naming an out-of-scope employee opens no drawer')

      const visible = await loadTimesheets({ timesheet: `${visibleEmployee}:2026-09-20` })
      assert.ok(visible.drawer, 'an in-scope employee can open a week')
      const pickers = (visible.drawer as unknown as { pickers: { projects: { label: string }[]; departments: { label: string }[] } }).pickers
      assert.ok(pickers.projects.some((item) => item.label.includes(visibleProject)))
      assert.ok(!pickers.projects.some((item) => item.label.includes(hiddenProject)), 'project picker excludes another subsidiary')
      assert.ok(pickers.departments.some((item) => item.label.includes(visibleDepartment)))
      assert.ok(!pickers.departments.some((item) => item.label.includes(hiddenDepartment)), 'department picker excludes another subsidiary')
      assert.ok(pickers.departments.some((item) => item.label.includes(orgWideDepartment)), 'org-wide departments remain available')
    })
  } finally {
    state.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

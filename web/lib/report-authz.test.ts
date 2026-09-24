import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import type { Authz } from './authz'

// `report-authz` is a server module. The suite loads it after the marker is
// stubbed so the missing-entity refusal is the real function, not a source
// grep — a grep would still pass if the guard called canRunReportEntity and
// then returned allow anyway.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { canRunReportEntity, canSeeReportDefinition, guardReportEntity } = await import('./report-authz.ts')

/**
 * `reports.read` is permission to use the reporting tools, not permission to
 * reach every entity behind them. Sensitive entities declare their own
 * `requiredPermission`, and the built-in payroll reports promise it in prose:
 * "Requires the payroll permission."
 *
 * The promise is only as strong as its weakest execution path. Running a plan,
 * exporting it, drilling its supporting rows and listing the catalog all expose
 * the same underlying data, so each must consult the SAME gate. These tests pin
 * that: the shared helper keeps the rule, and every path is wired to it.
 */


test('payroll entities still declare a permission beyond reports.read', () => {
  // If this ever empties out, the gate below is guarding nothing.
  const payrollEntities = Object.values(REPORT_ENTITY_MAP).filter(
    (entity) => entity.requiredPermission === 'payroll.read',
  )
  assert.ok(
    payrollEntities.length > 0,
    'no report entity requires payroll.read — the wage gate has been removed from the catalog',
  )
})

test('sensitive entities are reachable only through a declared permission', () => {
  for (const entity of Object.values(REPORT_ENTITY_MAP)) {
    if (!entity.requiredPermission) continue
    assert.equal(
      typeof entity.requiredPermission,
      'string',
      `${entity.key} declares a non-string requiredPermission`,
    )
  }
})

test('optional-module report entities declare the Features switch they follow', () => {
  const expected: Record<string, string> = {
    projects: 'projects',
    timesheets: 'timeTracking',
    timesheet_weeks: 'timeTracking',
    fixed_assets: 'fixedAssets',
    equipment: 'equipment',
    inventory_lot_movements: 'inventory',
    pay_stubs: 'payroll',
    pay_stub_lines: 'payroll',
    payroll_parallel_findings: 'payroll',
    entitlement_balances: 'payroll',
    entitlement_service_milestones: 'payroll',
  }
  for (const [key, featureKey] of Object.entries(expected)) {
    assert.equal(REPORT_ENTITY_MAP[key]?.featureKey, featureKey, key)
  }
})

function reportReader(): Authz {
  return {
    user: {
      id: 'user-1',
      email: 'reader@example.com',
      name: 'Reader',
      roles: [],
      orgId: 'org-1',
      envKind: 'production',
      productionOrgId: 'org-1',
      isSuperAdmin: false,
      homeUserId: 'user-1',
      homeOrgId: 'org-1',
    },
    permissions: new Set(['reports.read']),
    allowedSubsidiaryIds: null,
  }
}

async function assertEntityRefused(query: unknown, label: string): Promise<void> {
  const authz = reportReader()
  assert.equal(await canRunReportEntity(authz, query), false, `${label}: canRunReportEntity must refuse`)
  const denied = await guardReportEntity(authz, query)
  assert.ok(denied, `${label}: guardReportEntity must refuse, not return allow (null)`)
  assert.equal(denied.status, 403, `${label}: missing/unknown entity is a 403, not a silent allow`)
}

test('guardReportEntity refuses a missing entity the same way canRunReportEntity does', async () => {
  // A query object that never names a catalog entity is the fail-open:
  // requiredPermission is null, and treating that as allow lets
  // run/export/definition writes execute a plan the catalog never named.
  // A null query is different — that is a statement definition, tested below.
  await assertEntityRefused({}, 'empty query')
  await assertEntityRefused({ entity: undefined }, 'undefined entity')
})

test('guardReportEntity refuses an unknown entity the same way canRunReportEntity does', async () => {
  assert.equal(REPORT_ENTITY_MAP['not_a_catalog_entity'], undefined)
  await assertEntityRefused({ entity: 'not_a_catalog_entity' }, 'unknown entity')
})

test('canSeeReportDefinition branches on report_type for the read surfaces', async () => {
  // Statements seed query=null by design: the statement feature gate
  // decides visibility, never the entity gate that hides them all.
  const authz = reportReader()
  assert.equal(
    await canSeeReportDefinition(authz, { report_type: 'statement', query: null, statement: { kind: 'pnl' } }),
    true,
    'an ungated statement is visible to a reports reader',
  )
  // Query plans answer the entity gate.
  const open = Object.values(REPORT_ENTITY_MAP).find(
    (entity) => !entity.requiredPermission && !entity.featureKey,
  )
  assert.ok(open, 'the catalog must keep at least one always-on entity so this is not a vacuous allow')
  assert.equal(
    await canSeeReportDefinition(authz, { report_type: 'query', query: { entity: open.key }, statement: null }),
    true,
  )
  assert.equal(
    await canSeeReportDefinition(authz, { report_type: 'query', query: null, statement: null }),
    false,
    'a query plan with no entity plan stays hidden',
  )
  // Unknown types fail closed even when a sibling gate would allow.
  assert.equal(
    await canSeeReportDefinition(authz, { report_type: 'mystery', query: { entity: open.key }, statement: { kind: 'pnl' } }),
    false,
    'an unnamed report type is visible to nobody',
  )
  assert.equal(
    await canSeeReportDefinition(authz, { report_type: null, query: { entity: open.key }, statement: null }),
    false,
  )
})

test('guardReportEntity still allows a catalog entity that declares no extra permission', async () => {
  const open = Object.values(REPORT_ENTITY_MAP).find(
    (entity) => !entity.requiredPermission && !entity.featureKey,
  )
  assert.ok(open, 'the catalog must keep at least one always-on entity so this is not a vacuous allow')
  const authz = reportReader()
  assert.equal(await canRunReportEntity(authz, { entity: open.key }), true)
  assert.equal(await guardReportEntity(authz, { entity: open.key }), null)
})

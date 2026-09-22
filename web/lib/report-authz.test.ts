import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { readingPagePairs } from './page-source'
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

const { canRunReportEntity, guardReportEntity } = await import('./report-authz.ts')

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

const read = readingPagePairs((path: string) => readFileSync(new URL(path, import.meta.url), 'utf8'))

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

/** Every path that can execute a stored plan, and how it reaches the gate. */
const EXECUTION_PATHS: Array<{ file: string; symbol: string; why: string }> = [
  {
    file: '../app/api/reports/run/route.ts',
    symbol: 'guardReportEntity',
    why: 'running a saved definition or ad-hoc plan',
  },
  {
    file: '../app/api/reports/definitions/[id]/export/route.ts',
    symbol: 'guardReportEntity',
    why: 'exporting a definition to CSV/XLSX/PDF returns the same rows',
  },
  {
    file: './report-drill-data.ts',
    symbol: 'canRunReportEntity',
    why: "drilling returns the report's own supporting rows",
  },
  {
    file: '../app/api/reports/definitions/route.ts',
    symbol: 'canRunReportEntity',
    why: 'listing hands out the ids and stored plans every other path keys on',
  },
  {
    file: '../app/api/reports/definitions/route.ts',
    symbol: 'guardReportEntity',
    why: 'creating a definition must not persist an unknown or forbidden entity',
  },
  {
    file: '../app/api/reports/definitions/[id]/route.ts',
    symbol: 'guardReportEntity',
    why: 'saving a definition query must not persist an unknown or forbidden entity',
  },
  {
    file: '../app/api/reports/runs/[id]/csv/route.ts',
    symbol: 'canAccessReportArtifact',
    why: 'downloading a recorded run CSV returns the same rows',
  },
  {
    file: '../app/api/reports/runs/[id]/artifact/route.ts',
    symbol: 'canAccessReportArtifact',
    why: 'scheduled-run artifacts are the same report, rendered',
  },
]

for (const { file, symbol, why } of EXECUTION_PATHS) {
  test(`${file} applies the shared report entity gate (${why})`, () => {
    const source = read(file)
    assert.match(
      source,
      new RegExp(`\\b${symbol}\\b`),
      `${file} can execute a report plan without consulting lib/report-authz — ` +
        'a payroll register becomes readable with only reports.read.',
    )
    assert.match(
      source,
      /from '(\.\.\/)*(\.\.\/)*.*report-(?:authz|execution-context)'/,
      `${file} must import the gate rather than re-implement it`,
    )
  })
}

test('lot recall cannot bypass the inventory feature gate through either entry point', () => {
  const legacy = read('../app/(app)/reports/lot-recall/page.tsx')
  assert.match(legacy, /isFeatureEnabled\(authz\.user\.orgId, 'inventory'\)/)
  assert.match(legacy, /notFound\(\)/)

  const runner = read('../app/(app)/reports/custom/run/[id]/page.tsx')
  assert.match(runner, /canRunReportEntity\(authz, definition\.query\)/)
  assert.equal(REPORT_ENTITY_MAP.inventory_lot_movements?.featureKey, 'inventory')
})

test('a refused drill is an authorization outcome, not a 500', () => {
  const route = read('../app/api/reports/drill/route.ts')
  const mapped = read('../lib/report-drill-error.ts')
  assert.match(route, /reportDrillErrorResponse/)
  assert.match(mapped, /report_entity_forbidden/)
  assert.match(mapped, /status: 403/)
})

test('the gate lives in exactly one place', () => {
  // Re-deriving `requiredPermission` inline is how the export and drill paths
  // drifted from the runner in the first place.
  for (const { file } of EXECUTION_PATHS) {
    assert.doesNotMatch(
      read(file),
      /REPORT_ENTITY_MAP\[[^\]]+\]\??\.requiredPermission/,
      `${file} re-implements the entity gate instead of using lib/report-authz`,
    )
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

test('guardReportEntity does not refuse a statement definition with no entity plan', async () => {
  // Standard statements are seeded with query=null. The export route passes
  // that value into this gate unconditionally before the shared
  // CSV/XLSX/PDF pipeline. Refusing it 403s every P&L, balance sheet, and
  // trial-balance download. canRunReportEntity(null) stays false — it
  // answers "may I run this entity plan?" — but this HTTP gate must not
  // apply when there is no entity plan.
  const source = read('../app/api/reports/definitions/[id]/export/route.ts')
  assert.match(
    source,
    /guardReportEntity\(\s*gate,\s*def\.query\s*\)/,
    'export must keep passing the stored query, including statement null',
  )
  const authz = reportReader()
  assert.equal(await canRunReportEntity(authz, null), false)
  assert.equal(
    await guardReportEntity(authz, null),
    null,
    'null query is a statement plan, not a missing entity — the guard must return allow',
  )
  assert.equal(await guardReportEntity(authz, undefined), null)
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

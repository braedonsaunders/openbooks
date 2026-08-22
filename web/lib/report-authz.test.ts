import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'

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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

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
    file: '../app/api/reports/runs/[id]/csv/route.ts',
    symbol: 'guardReportEntity',
    why: 'downloading a recorded run CSV returns the same rows',
  },
  {
    file: '../app/api/reports/runs/[id]/artifact/route.ts',
    symbol: 'guardReportEntity',
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
      /from '(\.\.\/)*(\.\.\/)*.*report-authz'/,
      `${file} must import the gate rather than re-implement it`,
    )
  })
}

test('a refused drill is an authorization outcome, not a 500', () => {
  const route = read('../app/api/reports/drill/route.ts')
  assert.match(route, /report_entity_forbidden/)
  assert.match(route, /status: 403/)
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

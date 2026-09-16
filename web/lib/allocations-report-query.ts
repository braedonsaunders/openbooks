import { REPORT_ENTITY_MAP } from '@openbooks/reports'

/**
 * Db-free shaping for report_definition drivers (A8): validate the two
 * column picks against the entity catalog and read raw cell pairs back out
 * of the executed listing. Period injection reuses reportPeriodField /
 * applyPeriodOverride from custom-reports at run time (server-only); this
 * module stays import-safe for plain unit tests.
 */

function fail(message: string): never {
  throw new Error(`report driver: ${message}`)
}

/**
 * Both picks must be plain entity COLUMNS — a measure or an unknown key
 * fails loudly. Measures and group-bys reshape the result into buckets the
 * runner refuses to guess at.
 */
export function assertDriverColumns(entityKey: string, dimensionColumn: string, valueColumn: string): void {
  const entity = REPORT_ENTITY_MAP[entityKey]
  if (!entity) fail(`unknown report entity: ${entityKey}`)
  const dimension = entity.columns.find((c) => c.key === dimensionColumn)
  const value = entity.columns.find((c) => c.key === valueColumn)
  if (!dimension) fail(`dimension column not found: ${dimensionColumn}`)
  if (!value) fail(`value column not found: ${valueColumn}`)
  if (value.kind !== 'number' && value.kind !== 'money') {
    fail(`value column must be numeric, got ${value.kind}: ${valueColumn}`)
  }
}

/** Raw cell pairs → [dimensionKey, decimalText]. Skips blank dimensions. */
export function extractDriverRows(
  rows: (string | number | null | undefined)[][],
  dimensionIndex: number,
  valueIndex: number,
): [string, string][] {
  const out: [string, string][] = []
  for (const row of rows) {
    const dim = row[dimensionIndex]
    const dimKey = dim === null || dim === undefined ? '' : String(dim).trim()
    if (!dimKey) continue
    const val = row[valueIndex]
    out.push([dimKey, val === null || val === undefined ? '' : String(val).trim()])
  }
  return out
}

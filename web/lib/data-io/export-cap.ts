/**
 * Shared export row cap. Dependency-free on purpose: the unit-test doubles
 * for resource-core re-export this module, so it must not pull in db,
 * authz, or any other mockable surface.
 */
const DEFAULT_MAX_EXPORT_ROWS = 50_000

function configuredTestLimit(): number {
  const raw = process.env.NODE_ENV === 'test' ? process.env.OPENBOOKS_TEST_EXPORT_ROW_LIMIT : undefined
  if (raw === undefined) return DEFAULT_MAX_EXPORT_ROWS
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('OPENBOOKS_TEST_EXPORT_ROW_LIMIT must be a positive whole number')
  }
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit > DEFAULT_MAX_EXPORT_ROWS) {
    throw new Error(`OPENBOOKS_TEST_EXPORT_ROW_LIMIT must be between 1 and ${DEFAULT_MAX_EXPORT_ROWS}`)
  }
  return limit
}

/** Production exports always use the fixed limit; tests may exercise its boundary cheaply. */
export const MAX_EXPORT_ROWS = configuredTestLimit()

/**
 * Invariant: an export that would exceed the cap is refused and nothing is
 * written — never a truncated file presented as complete. The export takes
 * no narrowing argument, so the refusal says so and points at the
 * administrator instead of inventing a filter.
 *
 * Limitation: families post-filtered by bindReadScope (setup, master,
 * property, payroll) gate on pre-filter size, so hidden rows count toward
 * refusal — a restricted caller can be denied with fewer than 50,000
 * visible rows. Fail-closed by design; widening per-scope reads needs a
 * design review, not a silent pass-through.
 */
export class ExportRowLimitError extends Error {
  readonly code = 'EXPORT_ROW_LIMIT_EXCEEDED'
  readonly resourceLabel: string
  readonly limit: number
  constructor(resourceLabel: string) {
    super(
      `Export refused: "${resourceLabel}" has more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows, so the complete file cannot be produced and nothing was exported. ` +
        `This export cannot be narrowed — contact your administrator if you need these rows.`,
    )
    this.name = 'ExportRowLimitError'
    this.resourceLabel = resourceLabel
    this.limit = MAX_EXPORT_ROWS
  }
}

/**
 * Sentinel gate: callers fetch MAX_EXPORT_ROWS + 1 rows, so a result longer
 * than the cap proves overflow while exactly MAX_EXPORT_ROWS proves
 * completeness. Throws ExportRowLimitError; never slices.
 */
export function enforceExportRowLimit<T>(fetched: T[], resourceLabel: string): T[] {
  if (fetched.length > MAX_EXPORT_ROWS) throw new ExportRowLimitError(resourceLabel)
  return fetched
}

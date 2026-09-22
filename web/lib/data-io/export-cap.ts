/**
 * Shared export row cap. Dependency-free on purpose: the unit-test doubles
 * for resource-core re-export this module, so it must not pull in db,
 * authz, or any other mockable surface.
 */
export const MAX_EXPORT_ROWS = 50_000

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
  readonly limit = MAX_EXPORT_ROWS
  constructor(resourceLabel: string) {
    super(
      `Export refused: "${resourceLabel}" has more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows, so the complete file cannot be produced and nothing was exported. ` +
        `This export cannot be narrowed — contact your administrator if you need these rows.`,
    )
    this.name = 'ExportRowLimitError'
    this.resourceLabel = resourceLabel
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

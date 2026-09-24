/** Preserve valid zero precedence while using 100 for a blank/unset field. */
export function bankRulePriority(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 100
}

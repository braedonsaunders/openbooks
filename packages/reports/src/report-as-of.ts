// The org-calendar as-of sentinel shared by every report entity whose FROM
// clause reads point-in-time state. Leaf module (no imports) so entity
// catalogs beside entities.ts can use it without an import cycle.

/** Sentinel in static FROM SQL for the org-calendar as-of day (entitlement
 *  limit effective-dating). Compilers replace every occurrence with one bound
 *  parameter; the token is never sent to Postgres. */
export const REPORT_AS_OF = '__report_as_of__'

export function bindReportFromAsOf(
  from: string,
  asOf: string | undefined,
  bind: (value: string) => string,
): string {
  if (!from.includes(REPORT_AS_OF)) return from
  if (!asOf) throw new Error('report entity FROM requires asOf')
  return from.split(REPORT_AS_OF).join(bind(asOf))
}

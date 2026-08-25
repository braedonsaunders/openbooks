// Shared SQL binding helpers for drizzle `sql` templates.

/**
 * Drizzle binds an interpolated JS array as a row constructor `( $1, $2 )`,
 * which PostgreSQL rejects inside `any(<collection>::type[])` with
 * "cannot cast type record to …" once it holds more than one element. Bind
 * this escaped PostgreSQL array-literal text param instead — it works for
 * any element type chosen by the caller's cast (`::text[]`, `::uuid[]`, …).
 */
export function pgTextArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')}}`
}

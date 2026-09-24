import { sql } from "drizzle-orm";

/**
 * Build a predicate for an actor's allowed employer subsidiaries.
 * `null` means unrestricted; an empty set is deliberately always false.
 * `column` must be a static, code-owned SQL identifier/expression.
 */
export function employerSubsidiaryScope(
  allowed: Set<string> | null,
  column: string,
): ReturnType<typeof sql> {
  if (allowed === null) return sql`true`;
  if (allowed.size === 0) return sql`false`;
  const ids = [...allowed].map((id) => sql`${id}::uuid`);
  return sql`${sql.raw(column)} in (${sql.join(ids, sql`, `)})`;
}

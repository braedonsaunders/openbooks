import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { SETUP_ENTITIES } from "./registry";

/**
 * A setup entity whose table has no `id` column must say which column
 * identifies a row.
 *
 * The generic setup reader defaults to `id` (idColumn in ./coerce.ts), so
 * a per-org singleton keyed by org_id makes it select and order by a
 * column that does not exist. Nothing catches that until the page is
 * rendered against a real database: the type checker is happy, the unit
 * partition has no database, and the failure arrives as an error boundary
 * on a page whose own code is fine.
 *
 * Two shipped this way before this check existed — HR-14's qualification
 * settings and HR-21's AI rails settings, both org_id-keyed singletons,
 * both rehomed onto a module page, and the second one took /admin/ai down
 * in the e2e suite.
 */

const MIGRATIONS = "schema/migrations/generated";

/** Tables that declare a uuid `id`, from the published migrations. */
function tablesWithIdColumn(): Set<string> {
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
    .join("\n");
  const out = new Set<string>();
  // Migrations are written in both styles -- uppercase DDL with a `public.`
  // qualifier, and lowercase DDL with a bare table name. Matching only the
  // first made every table written in the second style INVISIBLE to this
  // check, which reports invisibility as an offence; two tax tables that do
  // declare `id uuid` were flagged that way.
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s*\(([\s\S]*?)\n\);/gi)) {
    if (/(?:^|,)\s*"?id"?\s+uuid/im.test(m[2]!)) out.add(m[1]!);
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?id"?\b/gi)) {
    out.add(m[1]!);
  }
  return out;
}

test("every setup entity can name the column that identifies one of its rows", () => {
  const withId = tablesWithIdColumn();
  const offenders: string[] = [];
  for (const entity of SETUP_ENTITIES) {
    if (entity.idColumn) continue;
    // Entities backed by org settings JSON name a table for registry
    // shape only; they never reach the generic SELECT.
    if (entity.dataSource) continue;
    // A table this check cannot find is reported rather than skipped: a
    // silent skip is how the two offenders got here in the first place.
    if (!withId.has(entity.table)) {
      offenders.push(`${entity.key} -> ${entity.table}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these setup entities have no id column in their table and declare no idColumn, " +
      "so the generic reader will select a column that does not exist:\n  " +
      offenders.join("\n  ") +
      "\n\nDeclare idColumn (org_id for a per-org singleton), or add the table to the " +
      "migrations if this check simply cannot see it.",
  );
});

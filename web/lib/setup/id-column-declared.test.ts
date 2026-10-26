import assert from "node:assert/strict";
import test from "node:test";
import { releaseSchemaSql } from "../../../scripts/release-schema-sql.mjs";
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

// source-pin-contract: setup-reader identity invariant — every setup entity must name the column that identifies one of its rows (idColumn or a table with a uuid id in the release schema); subjects derived from the setup registry crossed with the release schema (baseline plus forward migrations), never hand-listed.

/** Tables that declare a uuid `id`, from the release schema. */
function tablesWithIdColumn(): Set<string> {
  const sql = releaseSchemaSql();
  const out = new Set<string>();
  // The baseline is pg_dump form (uppercase DDL, `public.` qualifier);
  // forward migrations may use either case, with or without the qualifier.
  // A table body ends at its closing `);`, whether that sits on its own line
  // or ends the last column line; reading past it would swallow the next
  // table's definition and hide its columns.
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi,
  )) {
    const rest = sql.slice(m.index! + m[0].length);
    const end = rest.search(/\);\s*(?:\n|$)/);
    const body = end < 0 ? rest : rest.slice(0, end);
    if (/(?:^|,)\s*"?id"?\s+uuid/im.test(body)) out.add(m[1]!);
  }
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?id"?\b/gi,
  )) {
    out.add(m[1]!);
  }
  return out;
}

test("every setup entity can name the column that identifies one of its rows", () => {
  const withId = tablesWithIdColumn();
  // A schema reader that finds nothing would report every entity; one that
  // finds only a handful means the DDL form drifted from what it parses.
  assert.ok(
    withId.has("flows") && withId.size > 500,
    `release schema yielded ${withId.size} tables with a uuid id`,
  );
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
      "release schema if this check simply cannot see it.",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { SETUP_ENTITIES, toSnake } from "./registry";

/**
 * Every SetupEntity.orderBy must name real database columns.
 *
 * The generic list reader interpolates orderBy verbatim into
 * `order by ${orderExpr(entity)}` (admin/setup/[entity]/view.ts and
 * SetupEntitySection.tsx) — Postgres folds an unquoted camelCase
 * identifier to lowercase, so `effectiveFrom` reads as `effectivefrom`,
 * a column that does not exist, and the page renders the error boundary.
 * hrm-pay-bands shipped exactly this way.
 *
 * Each comma-separated term must be a snake_case identifier with optional
 * asc/desc and nulls first/last modifiers, and must resolve to a column
 * that exists on the entity's table: either declared in the registry
 * (field/column keys via toSnake, the idColumn/naturalKey, system columns
 * implied by the entity flags) or present in the published DDL. The DDL
 * leg matters — hrm-competencies orders by its real `position` column,
 * which the registry never declares as a field, and that ordering is
 * correct SQL the test must not flag.
 */

// source-pin-contract: setup-ordering invariant — every SetupEntity.orderBy term must resolve to a real column (registry declaration or published DDL); subjects derived from the setup registry crossed with every published migration, never hand-listed.
const MIGRATIONS = "schema/migrations/generated";

/** Real column names per table, from the published DDL. */
function ddlColumnsByTable(): Map<string, Set<string>> {
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
    .join("\n");
  const out = new Map<string, Set<string>>();
  const skip = /^(constraint|check|primary|foreign|unique|exclude|like)$/i;
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s*\(([\s\S]*?)\n\);/gi,
  )) {
    const cols = out.get(m[1]!) ?? new Set<string>();
    for (const line of m[2]!.split("\n")) {
      const name = line.match(/^\s*"([a-z_][a-z0-9_]*)"|\s*([a-z_][a-z0-9_]*)/i);
      const col = (name?.[1] ?? name?.[2] ?? "").toLowerCase();
      if (col && !skip.test(col)) cols.add(col);
    }
    out.set(m[1]!, cols);
  }
  return out;
}

function allowedColumns(
  entity: (typeof SETUP_ENTITIES)[number],
  ddl: Map<string, Set<string>>,
): Set<string> {
  const out = new Set<string>();
  for (const f of entity.fields) out.add(toSnake(f.key));
  for (const c of entity.columns) out.add(toSnake(c.key));
  out.add(entity.idColumn ?? "id");
  if (entity.naturalKey) out.add(toSnake(entity.naturalKey));
  if (entity.orgScoped) out.add("org_id");
  if (entity.actorCols) {
    out.add("created_at");
    out.add("created_by");
    out.add("updated_at");
    out.add("updated_by");
  }
  if (entity.hasActive) out.add("is_active");
  for (const col of ddl.get(entity.table) ?? []) out.add(col);
  return out;
}

const TERM_RE =
  /^([A-Za-z][A-Za-z0-9_]*)(\s+(asc|desc))?(\s+nulls\s+(first|last))?$/i;
const SNAKE_RE = /^[a-z][a-z0-9_]*$/;

test("every SetupEntity.orderBy names only declared snake_case columns", () => {
  const ddl = ddlColumnsByTable();
  const offenders: string[] = [];
  for (const entity of SETUP_ENTITIES) {
    if (entity.dataSource) continue; // settings-JSON backed; never reaches SQL
    if (!entity.orderBy) continue;
    const allowed = allowedColumns(entity, ddl);
    for (const rawTerm of entity.orderBy.split(",")) {
      const term = rawTerm.trim();
      const m = term.match(TERM_RE);
      if (!m) {
        offenders.push(`${entity.key}: orderBy term ${JSON.stringify(term)} is not <column> [asc|desc] [nulls first|last]`);
        continue;
      }
      const col = m[1]!;
      if (!SNAKE_RE.test(col)) {
        offenders.push(
          `${entity.key}: orderBy column ${JSON.stringify(col)} is not snake_case — the generic reader sends it to Postgres unquoted, which folds it to ${JSON.stringify(col.toLowerCase())}`,
        );
        continue;
      }
      if (!allowed.has(col)) {
        offenders.push(`${entity.key}: orderBy column ${JSON.stringify(col)} is not a declared field/column of the entity`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "SetupEntity.orderBy terms must be declared snake_case columns:\n  " +
      offenders.join("\n  "),
  );
});

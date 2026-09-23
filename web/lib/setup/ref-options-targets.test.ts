import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { SETUP_ENTITIES, SETUP_ENTITY_BY_KEY, refTargetPicker, toSnake } from "./registry";

/**
 * Every registry entity served as a ref-option source must resolve its
 * generic picker columns to fields that exist.
 *
 * loadEntityOptions (./ref-options.ts) builds `select <value> as value,
 * <label> as label ... order by <order>` from the TARGET entity's
 * declaration: the value is refValue (or the idColumn), the label comes
 * from code/name — else key/label — else the naturalKey, and the ordering
 * follows the same priority. hrm-document-categories declares key/label
 * and neither code nor name, so the old hardcoded code/name picker
 * selected nonexistent columns and /hrm/documents rendered the error
 * boundary; its referencing fields store the category KEY, so the option
 * value must be the key, not the row id the write path cannot take back.
 *
 * This test pins the contract over every ref target at once: the value
 * column exists, the label/order columns the derivation picks exist, and
 * a declared refValue names a real field — so the next key/label-shaped
 * (or otherwise non-code/name) entity fails here, not in render.
 */

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
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    const cols = out.get(m[1]!) ?? new Set<string>();
    cols.add(m[2]!.toLowerCase());
    out.set(m[1]!, cols);
  }
  return out;
}

/** Sources with a dedicated branch in loadEntityOptions (never generic). */
const DEDICATED = new Set([
  "accounts",
  "vendors",
  "accounting-periods",
  "items",
  "customers",
  "employees",
  "equipment-units",
  "job-titles",
  "trades",
  "projects",
  "number-sequence-kinds",
]);

test("every ref target resolves its generic picker columns", () => {
  const ddl = ddlColumnsByTable();
  const offenders: string[] = [];
  const targets = new Map<string, (typeof SETUP_ENTITIES)[number]>();
  for (const entity of SETUP_ENTITIES) {
    for (const c of entity.columns) if (c.ref) targets.set(c.ref, SETUP_ENTITY_BY_KEY.get(c.ref)!);
    for (const f of entity.fields) if (f.ref) targets.set(f.ref, SETUP_ENTITY_BY_KEY.get(f.ref)!);
  }
  for (const [source, target] of targets) {
    if (!target || DEDICATED.has(source)) continue;
    if (target.dataSource) continue; // settings-JSON backed; never reaches SQL
    const fieldKeys = new Set(target.fields.map((f) => f.key));
    const declared = new Set([
      ...target.fields.map((f) => toSnake(f.key)),
      ...target.columns.map((c) => toSnake(c.key)),
    ]);
    const tableCols = new Set([...declared, ...(ddl.get(target.table) ?? [])]);
    // refValue names the stored value: it must be a real field.
    if (target.refValue != null && !fieldKeys.has(target.refValue)) {
      offenders.push(`${source}: refValue ${JSON.stringify(target.refValue)} is not a declared field of ${target.key}`);
    }
    // The REAL derivation loadEntityOptions builds its SQL from — every
    // column it emits must exist on the table. (A target with no
    // code/name/key/label still renders — hrm-kit-attributes labels its
    // rows by id — but it must never select a missing column.)
    const picked = refTargetPicker(target);
    if (!tableCols.has(picked.valueCol)) {
      offenders.push(`${source}: option value column ${JSON.stringify(picked.valueCol)} does not exist on ${target.table}`);
    }
    for (const col of picked.labelCols) {
      if (!tableCols.has(col)) {
        offenders.push(`${source}: option label column ${JSON.stringify(col)} does not exist on ${target.table}`);
      }
    }
    if (!tableCols.has(picked.orderCol)) {
      offenders.push(`${source}: option order column ${JSON.stringify(picked.orderCol)} does not exist on ${target.table}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "ref targets must resolve their generic picker columns:\n  " + offenders.join("\n  "),
  );
});

test("document categories are referenced by key, not by row id", () => {
  const target = SETUP_ENTITY_BY_KEY.get("hrm-document-categories");
  assert.ok(target, "hrm-document-categories must stay registered");
  assert.equal(
    target.refValue,
    "key",
    "templates and retention schedules store the category KEY — the picker must offer it",
  );
  // The reported crash shape: key/label, neither code nor name. The
  // derivation must pick the columns the entity actually declares.
  assert.deepEqual(refTargetPicker(target), {
    valueCol: "key",
    labelCols: ["key", "label"],
    orderCol: "label",
  });
});

#!/usr/bin/env node
/**
 * Every tenant (org-owned) table the release schema creates must be
 * classified in engine/src/sandbox/tenant-table-policies.ts. Sandbox clone,
 * refresh, promote and backup build their catalog from that map and refuse to
 * run when a tenant table is unclassified, so an omission otherwise surfaces
 * only in the database partition. This check reads the release schema (the
 * active baseline, every forward migration in apply order, and the
 * environments.sql backstop) statically, with no database, so it runs in
 * every landing gate.
 *
 *   node scripts/check-tenant-table-policies.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseSchemaFiles } from "./release-schema-sql.mjs";
const root = ".";
const files = [
  ...releaseSchemaFiles(root).map(({ path }) => path),
  join(root, "schema/migrations/environments.sql"),
];
const tables = new Map();
for (const f of files) {
  // Line comments are prose: a comment that mentions DROP TABLE must not swallow the statement after it.
  const sql = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
  for (const m of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\);/gi,
  ))
    tables.set(m[1], /\borg_id\b/.test(m[2]));
  for (const m of sql.matchAll(
    /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?"?([a-z0-9_]+)"? RENAME TO "?([a-z0-9_]+)"?/gi,
  )) {
    if (tables.has(m[1])) {
      tables.set(m[2], tables.get(m[1]));
      tables.delete(m[1]);
    }
  }
  for (const m of sql.matchAll(
    /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?"?([a-z0-9_]+)"? ADD COLUMN (?:IF NOT EXISTS )?org_id\b/gi,
  ))
    if (tables.has(m[1])) tables.set(m[1], true);
  // One DROP TABLE may name several tables, as tables that reference one another leave together.
  for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?([^;]+);/gi)) {
    for (const name of m[1].split(",")) {
      const table = name.trim().match(/^(?:public\.)?"?([a-z0-9_]+)"?/i);
      if (table) tables.delete(table[1]);
    }
  }
}
function policyEntries(text) {
  // A bare identifier and a quoted key name the same table.
  return [...text.matchAll(/^\s+"?([a-z0-9_]+)"?:\s*"([^"]+)"/gm)];
}
const policyText = readFileSync(join(root, "engine/src/sandbox/tenant-table-policies.ts"), "utf8");
const policy = new Set(policyEntries(policyText).map((m) => m[1]));
const missing = [...tables]
  .filter(([t, org]) => org && !policy.has(t))
  .map(([t]) => t)
  .sort();
// catalog.ts keeps two hand lists the policies must agree with, and the clone
// refuses at runtime when they drift: every skip:no-copy table is in EXCLUDE,
// and every clone:parent-filter table has a PARENT_FILTER entry. Compare them
// here too.
const policies = new Map(policyEntries(policyText).map((m) => [m[1], m[2]]));
const catalog = readFileSync(join(root, "engine/src/sandbox/catalog.ts"), "utf8").replace(
  /^\s*\/\/.*$/gm,
  "",
);
const block = (start, end) => {
  const a = catalog.indexOf(start);
  return a < 0 ? "" : catalog.slice(a + start.length, catalog.indexOf(end, a));
};
const exclude = new Set(
  [...block("export const EXCLUDE = new Set([", "]);").matchAll(/"([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  ),
);
const parentFilter = new Set(
  [...block("export const PARENT_FILTER", "\n};").matchAll(/^\s+"?([a-z0-9_]+)"?:/gm)].map(
    (m) => m[1],
  ),
);
const drift = [...policies].flatMap(([t, p]) => [
  ...((p === "skip:no-copy") !== exclude.has(t)
    ? [
        `${t} (${p}${exclude.has(t) ? ", in EXCLUDE" : ", missing from EXCLUDE in engine/src/sandbox/catalog.ts"})`,
      ]
    : []),
  ...((p === "clone:parent-filter") !== parentFilter.has(t)
    ? [
        `${t} (${p}${parentFilter.has(t) ? ", has a PARENT_FILTER entry" : ", missing from PARENT_FILTER"})`,
      ]
    : []),
]);
// A schema reader that parses nothing would pass every table; refuse instead.
const orgOwned = [...tables.values()].filter(Boolean).length;
if (orgOwned === 0) {
  console.error(
    "no org-owned tables parsed from the release schema; the baseline is missing or its form changed",
  );
  process.exitCode = 1;
}
console.log(
  `checked tenant table policies; tables=${tables.size} org-owned=${orgOwned} policies=${policy.size} missing=${missing.length} catalog-drift=${drift.length}`,
);
if (missing.length) {
  console.error(
    `unclassified tenant tables (add to engine/src/sandbox/tenant-table-policies.ts): ${missing.join(", ")}`,
  );
  process.exitCode = 1;
}
if (drift.length) {
  console.error(`tenant table policies disagree with the sandbox catalog: ${drift.join("; ")}`);
  process.exitCode = 1;
}

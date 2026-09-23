#!/usr/bin/env node
/**
 * Every API route that mutates an org-wide configuration table must enforce
 * unrestricted subsidiary scope. The governed set is deliberately table
 * based: each table is checked against the generated schema so adding a
 * subsidiary anchor requires an explicit review of this policy.
 */
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schemaFiles = globSync("schema/migrations/generated/*.sql", { cwd: root });
const schema = schemaFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

// Configuration tables with no subsidiary ownership column. A policy table
// added here is derived into every route that writes it below.
const policyTables = ["flows", "allocation_drivers"];
for (const table of policyTables) {
  const declaration = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(schema);
  assert.ok(declaration, `governed org-wide config table ${table} has no generated schema declaration`);
  assert.doesNotMatch(declaration[1], /\bsubsidiary_id\b/i, `${table} gained a subsidiary anchor; review its scope policy`);
}
const routes = globSync("web/app/api/**/route.ts", { cwd: root }).sort();
const writes = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  const touched = policyTables.filter((table) => {
    const directWrite = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${table}\\b`, "i").test(source);
    // Allocation driver CRUD delegates its SQL writer to driver-admin.ts.
    const delegatedWrite = table === "allocation_drivers" && /\b(?:createDriver|updateDriver|deleteDriver)\s*\(/.test(source);
    return directWrite || delegatedWrite;
  });
  // Cashflow categories are stored under orgs.settings and have no subsidiary
  // row anchor; detect that JSON policy by the key plus an org mutation.
  if (/cashflowCategories/.test(source) && /\bupdate\s+orgs\b/i.test(source)) touched.push("orgs.settings.analytics.cashflowCategories");
  if (touched.length === 0) continue;
  writes.push({ file, tables: touched });
  assert.match(
    source,
    /guardUnrestrictedScope\s*\(/,
    `${file} writes org-wide configuration (${touched.join(", ")}) without guardUnrestrictedScope`,
  );
}

console.log(`org-wide config scope: ${writes.length} route(s), ${writes.reduce((n, row) => n + row.tables.length, 0)} write target(s)`);
for (const row of writes) console.log(`  ${row.file}: ${row.tables.join(", ")}`);

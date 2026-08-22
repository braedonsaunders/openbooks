import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationSource = readFileSync("engine/src/sync/source.ts", "utf8");
const loader = readFileSync("engine/src/sync/migrate.ts", "utf8");
const fieldTicketImporter = readFileSync(
  "engine/src/validation/import-field-tickets.ts",
  "utf8",
);

test("connector identity is adapter-scoped and has no cross-source fallback", () => {
  assert.match(
    migrationSource,
    /never compared to[\s\S]{0,30}another adapter's id/i,
  );
  assert.match(migrationSource, /explicit, reviewed one-to-one mapping/i);
  assert.match(loader, /custom->>\$\{refKey\} = \$\{sourceRef\}/);
  assert.match(loader, /contains multiple rows for connector identity/);
  assert.match(loader, /contains duplicate connector identity/);
  assert.match(loader, /connector name must be a stable source namespace/);
  assert.doesNotMatch(loader, /findProjectByRef[\s\S]{0,500}custom->'source'/);
  assert.doesNotMatch(loader, /findPartyByRef[\s\S]{0,500}custom->'source'/);
});

test("role upserts pin the known tenant on the party_id conflict write", () => {
  assert.match(
    loader,
    /on conflict \(party_id\) do update set[\s\S]*?where org_id = \$\{orgId\}/,
  );
});

test("loaded entities retain canonical source identity alongside the adapter key", () => {
  assert.match(loader, /\[refKey\]: rec\.sourceRef/);
  assert.match(
    loader,
    /source:\s*\{\s*system:\s*ctx\.sourceName,\s*externalId:\s*rec\.sourceRef\s*\}/,
  );
  assert.match(loader, /\$\{custom\}::jsonb \|\| parties\.custom/);
});

test("time type persist writes cost_multiplier through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistTimeTypeCostMultiplier");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistTimeTypeCostMultiplier helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "time_types")');
  const next = loader.indexOf('if (resource === "tax_codes")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistTimeTypeCostMultiplier\(/);
  assert.doesNotMatch(body, /normalizeMoney\("1"\)/);
});

test("connector field-ticket imports require an explicit source namespace", () => {
  assert.match(fieldTicketImporter, /--source-system is required/);
  assert.match(fieldTicketImporter, /select base_currency from orgs/);
  assert.match(fieldTicketImporter, /externalId: t\.sourceId/);
  assert.doesNotMatch(fieldTicketImporter, /'CAD'/);
});

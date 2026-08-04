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

test("loaded entities retain canonical source identity alongside the adapter key", () => {
  assert.match(loader, /\[refKey\]: rec\.sourceRef/);
  assert.match(
    loader,
    /source:\s*\{\s*system:\s*ctx\.sourceName,\s*externalId:\s*rec\.sourceRef\s*\}/,
  );
  assert.match(loader, /\$\{custom\}::jsonb \|\| parties\.custom/);
});

test("connector field-ticket imports require an explicit source namespace", () => {
  assert.match(fieldTicketImporter, /--source-system is required/);
  assert.match(fieldTicketImporter, /select base_currency from orgs/);
  assert.match(fieldTicketImporter, /externalId: t\.sourceId/);
  assert.doesNotMatch(fieldTicketImporter, /'CAD'/);
});

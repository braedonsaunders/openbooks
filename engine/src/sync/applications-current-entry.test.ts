import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(import.meta.dirname, "applications.ts"), "utf8");
const balanceMigration = readFileSync(
  new URL("../../../schema/migrations/generated/0100_document_open_balance_currency.sql", import.meta.url),
  "utf8",
);

test("open-balance heal pins the known tenant on the subsequent id write", () => {
  assert.match(
    source,
    /recompute_document_open_balances\(\$\{orgId\}::uuid\)/,
  );
  assert.match(balanceMigration, /WHERE d\.id = b\.id AND d\.org_id = p_org/);
  assert.match(balanceMigration, /d\.open_balance IS DISTINCT FROM b\.balance/);
});

test("application reconciliation resolves the document's current posted entry regardless of correction origin", () => {
  assert.match(
    source,
    /join documents d on d\.id = e\.source_document_id and d\.posted_entry_id = e\.id/,
  );
  assert.match(source, /where e\.status = 'posted'/);
  assert.doesNotMatch(source, /e\.origin = 'document'/);
});

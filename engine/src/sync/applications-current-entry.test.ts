import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(import.meta.dirname, "applications.ts"), "utf8");

test("open-balance heal pins the known tenant on the subsequent id write", () => {
  assert.match(
    source,
    /where d\.id = c\.id and d\.org_id = \$\{orgId\} and d\.open_balance is distinct from c\.ob/,
  );
});

test("application reconciliation resolves the document's current posted entry regardless of correction origin", () => {
  assert.match(
    source,
    /join documents d on d\.id = e\.source_document_id and d\.posted_entry_id = e\.id/,
  );
  assert.match(source, /where e\.status = 'posted'/);
  assert.doesNotMatch(source, /e\.origin = 'document'/);
});

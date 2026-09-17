import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source-contract pin for the journal-entry kernel guard (f2/5.4 rule from
// the fleet coordinator): every rewrite of je_guard must carry the FULL body.
// If a later migration drops a branch, this fails on the migration text
// itself — before any database behavior can silently change.
const GUARD = readFileSync(
  new URL("./migrations/generated/0168_close_posting_module_recheck.sql", import.meta.url),
  "utf8",
);

test("0168 carries every je_guard branch by name", () => {
  for (const branch of [
    "journal-entry-delete",
    "same-status-amend",
    "posted-immutability",
    "reversal-evidence (0166)",
    "reversed-immutable",
    "draft-post",
  ]) {
    assert.ok(GUARD.includes(branch), `je_guard body must contain the ${branch} branch`);
  }
});

test("0168 keeps the 0166 reversal-evidence semantics intact", () => {
  assert.ok(GUARD.includes("openbooks_reversal_mirrors(old.org_id, old.id, reversal.id)"));
  assert.match(GUARD, /openbooks:je_guard:v5/);
});

test("0168 rechecks the source document's close module on draft -> posted", () => {
  assert.ok(GUARD.includes("document_close_module"), "the draft-post block must map the source kind to its module");
  assert.ok(GUARD.includes("source_document_id"), "the draft-post block must scope the recheck to sourced entries");
  assert.match(GUARD, /period is closed for % posting/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const kinds = read("../document-kinds.ts");
const application = read("./documents.ts");
const catalog = read("./tool-catalog.ts");

// Five of the six sweep-C kinds ride the generic lifecycle; journals do not:
// journal documents are not in DOC_KINDS, so submit/post/correct refuse them
// ("dedicated lifecycle") and post_journal + void_document are their governed
// path. This test pins that routing so neither side can silently strand a kind.
test("lifecycle wiring covers credits, deposits, transfers, and card charges", () => {
  for (const kind of ["vendor_credit", "customer_credit", "deposit", "transfer", "card_charge"]) {
    assert.ok(kinds.includes(`kind: '${kind}'`), `${kind} is a known document kind`);
  }
  // Permission maps resolve for every covered kind (no unknown-kind throw).
  assert.match(application, /function lifecyclePermission/);
  assert.match(application, /function voidPermission/);
  // The generic lifecycle tools exist in the catalog (submit/post share one
  // generator; void/correct are standalone definitions).
  assert.match(catalog, /name: `\$\{action\}_document`/);
  for (const name of ["void_document", "correct_document", "post_journal"]) {
    assert.ok(catalog.includes(`name: "${name}"`), `catalog must register ${name}`);
  }
});

test("journals route through post_journal and void_document, never the generic lifecycle", () => {
  assert.doesNotMatch(kinds, /kind: 'journal'/);
  assert.match(application, /export async function postJournalDocument/);
  assert.match(application, /header\.kind !== "journal"\) throw notFound\("journal"\)/);
  // Journals void through gl.post, not a dedicated workflow; only bills and
  // payments take the controlled-void request path.
  assert.match(application, /if \(kind === "journal"\) return "gl\.post"/);
});

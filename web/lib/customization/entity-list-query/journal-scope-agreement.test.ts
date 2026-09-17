import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";

// F-t11-010: the setup guide, the journal header, and the journal list each
// counted "posted entries" with a different SQL scope, so Rassaun read
// 85,322 / 25,943 / 47,625 on three surfaces at once. All three now read
// the JOURNAL_ENTRY_TABLE union through journalScopeWhere. This pins the
// agreement without a database: the header/guide scope must be exactly the
// predicate the list total applies under the journal default view, carry no
// status filter of its own, and keep the list's subsidiary fence. The
// Rassaun-shaped row coverage (doc-linked migration postings in, pure
// subledger postings out, reversed entries in) lives in the companion
// journal-scope-agreement.integration.test.ts, which needs a fixture
// database. Only server-only is stubbed; query building is offline.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/db.ts");
const { JOURNAL_ENTRY_TABLE, journalEntryWhere, journalScopeWhere } = await import("./journal-entries.ts");
const { defaultListView } = await import("@openbooks/customization");

const ORG = "019f5ea3-44c5-72c0-ad3b-ef34c19c8763";
const SUB_A = "11111111-1111-4111-8111-111111111111";
const SUB_B = "22222222-2222-4222-8222-222222222222";

function buildTotalSql(where: SQL): { text: string; params: unknown[] } {
  const built = db
    .select({ n: sql`count(*)` })
    .from(sql.raw(`${JOURNAL_ENTRY_TABLE} e`))
    .where(where)
    .toSQL();
  return { text: built.sql, params: built.params as unknown[] };
}

test("header/guide scope is exactly the list-total predicate", () => {
  const scope = buildTotalSql(journalScopeWhere(ORG, null));
  const list = buildTotalSql(journalEntryWhere(defaultListView("journal"), {}, ORG, null));
  assert.equal(scope.text, list.text, "shared scope and default-view list total build identical SQL");
  assert.deepEqual(scope.params, list.params, "shared scope and default-view list total bind identical params");
});

test("the shared scope carries no status filter of its own", () => {
  const { text } = buildTotalSql(journalScopeWhere(ORG, null));
  assert.match(text, /e\.org_id/, "scope is org-wide");
  assert.doesNotMatch(text, /status/, "scope adds no status predicate");
});

test("the shared scope keeps the list subsidiary fence", () => {
  assert.doesNotMatch(
    buildTotalSql(journalScopeWhere(ORG, null)).text,
    /subsidiary_id/,
    "unfenced scope mentions no subsidiary",
  );
  const fenced = buildTotalSql(journalScopeWhere(ORG, new Set([SUB_A, SUB_B])));
  assert.match(fenced.text, /subsidiary_id/, "fenced scope constrains subsidiaries");
  assert.deepEqual(fenced.params.slice(1), [ORG, `{${SUB_A},${SUB_B}}`], "fence binds the org and the id set");
  assert.match(
    buildTotalSql(journalScopeWhere(ORG, new Set())).text,
    /false/,
    "empty fence matches nothing",
  );
});

test("the journal default view carries no filters to split the counts", () => {
  assert.deepEqual(defaultListView("journal").filters, [], "default journal view adds no predicate");
});

test("the backing relation unions native legs with journal/pay-run documents", () => {
  assert.match(JOURNAL_ENTRY_TABLE, /union/i, "both visibility legs present");
  assert.match(JOURNAL_ENTRY_TABLE, /'migration'/, "migration true-ups stay list-visible");
  assert.match(JOURNAL_ENTRY_TABLE, /'journal', 'pay_run'/, "journal/pay-run document leg present");
});

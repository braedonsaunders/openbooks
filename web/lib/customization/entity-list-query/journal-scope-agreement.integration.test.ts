import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// F-t11-010: the setup guide, the journal header, and the journal list each
// counted "posted entries" with a different scope (guide: every posted or
// reversed entry in the org; header: journalsOnly with no status filter;
// list: the JOURNAL_ENTRY_TABLE union with no status filter), so one
// tenant read three different totals on three surfaces at once. All three
// now count one scope — the journal-list union — through journalScopeWhere.
// The fixture is a miniature of that tenant: a doc-linked migration posting
// (the 21,770-class the old header dropped), a reversed journal-document
// entry (the 42-class a posted-only unification would drop), and a pure
// subledger posting (bills live in their module, never in the journal).
// SQL builders and storage are real; only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { JOURNAL_ENTRY_TABLE, journalEntryWhere, journalScopeWhere } = await import("./journal-entries.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;
const DATE = "2026-07-15";

async function postBalanced(
  org: { orgId: string; bookId: string; periodId: string; subsidiaryId: string; accounts: { bank: string; cogs: string } },
  entryNumber: string,
  origin: string,
  status: "posted" | "reversed",
): Promise<string> {
  const id = (await db.execute<{ id: string }>(sql`insert into journal_entries
    (org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, origin, status, memo)
    values (${org.orgId}, ${org.bookId}, ${entryNumber}, ${DATE}, ${org.periodId}, ${org.subsidiaryId},
      ${origin}, 'draft', ${entryNumber})
    returning id`)).rows[0]!.id;
  await db.execute(sql`insert into journal_lines
    (org_id, entry_id, line_number, account_id, amount, txn_amount, currency, subsidiary_id, posting_date)
    values (${org.orgId}, ${id}, 1, ${org.accounts.bank}, '100.00', '100.00', 'CAD', ${org.subsidiaryId}, ${DATE}),
           (${org.orgId}, ${id}, 2, ${org.accounts.cogs}, '-100.00', '-100.00', 'CAD', ${org.subsidiaryId}, ${DATE})`);
  await db.execute(sql`update journal_entries set status = ${status} where id = ${id}`);
  return id;
}

async function linkDocument(
  org: { orgId: string; periodId: string; subsidiaryId: string },
  kind: string,
  documentNumber: string,
  entryId: string,
): Promise<void> {
  await db.execute(sql`insert into documents
    (org_id, kind, document_number, document_date, currency, subsidiary_id, status, posted_entry_id, posting_period_id)
    values (${org.orgId}, ${kind}, ${documentNumber}, ${DATE}, 'CAD', ${org.subsidiaryId},
      'posted', ${entryId}, ${org.periodId})`);
}

async function scopeCount(orgId: string): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(JOURNAL_ENTRY_TABLE)} e
      where ${journalScopeWhere(orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

async function listTotal(orgId: string): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(JOURNAL_ENTRY_TABLE)} e
      where ${journalEntryWhere(defaultListView("journal"), {}, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("guide, header, and list count one journal scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await scopeCount(org.orgId), 0, "empty org starts empty");
    await postBalanced(org, "JE-T11-001", "manual", "posted");
    await postBalanced(org, "JE-T11-002", "manual", "reversed");
    await linkDocument(org, "vendor_bill", "VB-T11-003", await postBalanced(org, "JE-T11-003", "migration", "posted"));
    await linkDocument(org, "journal", "JR-T11-004", await postBalanced(org, "JE-T11-004", "manual", "posted"));
    await linkDocument(org, "vendor_bill", "VB-T11-005", await postBalanced(org, "JE-T11-005", "document", "posted"));
    await linkDocument(org, "pay_run", "PR-T11-006", await postBalanced(org, "JE-T11-006", "manual", "posted"));
    await linkDocument(org, "journal", "JR-T11-007", await postBalanced(org, "JE-T11-007", "manual", "reversed"));
    // Six of seven: everything except the pure subledger posting, whose
    // bill lives in its own module. The doc-linked migration posting and
    // both reversed entries stay in — the journal list shows them, so the
    // header and guide count them too.
    assert.equal(await scopeCount(org.orgId), 6, "shared scope counts six of seven fixture entries");
    assert.equal(await listTotal(org.orgId), 6, "list total counts the same six");
    assert.equal(await scopeCount(org.orgId), await listTotal(org.orgId), "header/guide scope agrees with the list total");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

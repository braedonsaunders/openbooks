import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

// Header, setup guide, and list must count the same journal scope. The
// fixture includes standalone journals, source-linked migration postings,
// reversed journal records, and ordinary subledger postings. Query builders
// and storage are real; only server-only is stubbed.
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { JOURNAL_ENTRY_TABLE, journalEntryWhere, journalScopeWhere } = await import("./journal-entries.ts");
const { defaultListView } = await import("@openbooks/customization");
const { readResolvedEntityListPageForView } = await import("../../list/entity-reader.ts");

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
  const { withBypass } = await import("@openbooks/engine/src/platform/db.ts");
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      assert.equal(await scopeCount(org.orgId), 0, "empty org starts empty");
      await postBalanced(org, "JE-T11-001", "manual", "posted");
      await postBalanced(org, "JE-T11-002", "manual", "reversed");
      await linkDocument(org, "vendor_bill", "VB-T11-003", await postBalanced(org, "JE-T11-003", "migration", "posted"));
      await linkDocument(org, "journal", "JR-T11-004", await postBalanced(org, "JE-T11-004", "manual", "posted"));
      await linkDocument(org, "vendor_bill", "VB-T11-005", await postBalanced(org, "JE-T11-005", "document", "posted"));
      await linkDocument(org, "pay_run", "PR-T11-006", await postBalanced(org, "JE-T11-006", "manual", "posted"));
      await linkDocument(org, "journal", "JR-T11-007", await postBalanced(org, "JE-T11-007", "manual", "reversed"));
      // Source-linked migration corrections stay with their subledger document.
      // Both reversed journal records remain in the journal scope.
      assert.equal(await scopeCount(org.orgId), 5, "shared scope excludes both vendor-bill postings");
      assert.equal(await listTotal(org.orgId), 5, "list total uses the same journal scope");
      assert.equal(await scopeCount(org.orgId), await listTotal(org.orgId), "header/guide scope agrees with the list total");
      const page = await readResolvedEntityListPageForView({
        recordType: "journal", orgId: org.orgId, allowedSubsidiaryIds: null,
        view: defaultListView("journal"), sort: "date", dir: "desc", page: 1, perPage: 5,
      }, { inventory: true, crm: false, hrm: false });
      assert.ok(page.ok, "the bounded page query executes");
      assert.equal(page.filteredTotal, 5);
      assert.equal(page.rows.length, 5);
      assert.ok(page.rows.every((row) => row.line_count === '2' && row.total_debits === '100.0000'), "the returned page hydrates its ledger totals");
      const draft = (await db.execute<{ id: string }>(sql`insert into documents
        (org_id, kind, document_number, document_date, currency, subsidiary_id, status)
        values (${org.orgId}, 'journal', 'JE-DRAFT', ${DATE}, 'CAD', ${org.subsidiaryId}, 'draft') returning id`)).rows[0]!.id;
      await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, amount)
        values (${org.orgId}, ${draft}, 1, ${org.accounts.bank}, '95.00'),
               (${org.orgId}, ${draft}, 2, ${org.accounts.cogs}, '-95.00')`);
      const drafts = await readResolvedEntityListPageForView({
        recordType: "journal_draft", orgId: org.orgId, allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        view: defaultListView("journal_draft"), sort: "date", dir: "desc", page: 1, perPage: 5,
      }, { inventory: true, crm: false, hrm: false });
      assert.ok(drafts.ok);
      assert.equal(drafts.filteredTotal, 1);
      assert.equal(drafts.rows[0]?.total_debits, '95.0000', "draft list shows debit total, not the balanced document's net zero");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { autoMatch, importStatement, markReconciled, reconciliationTotals, startReconciliation } from "./banking.ts";

async function deposit(org: ScratchOrg, actorId: string, amount: string, date: string) {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents (id,org_id,kind,document_number,subsidiary_id,document_date,posting_date,
      currency,status,subtotal,tax_total,total,created_by)
    values (${id},${org.orgId},'journal',${`JE-${id}`},${org.subsidiaryId},${date},${date},
      'CAD','draft','0','0','0',${actorId})`);
  await db.execute(sql`
    insert into document_lines (org_id,document_id,line_number,account_id,subsidiary_id,
      quantity,unit_price,amount,tax_amount,created_by)
    values (${org.orgId},${id},1,${org.accounts.bank},${org.subsidiaryId},1,${amount},${amount},0,${actorId}),
      (${org.orgId},${id},2,${org.accounts.adjustment},${org.subsidiaryId},1,${`-${amount}`},${`-${amount}`},0,${actorId})`);
  await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
  const entryId = await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  }, { audit: { actorId, source: "test" } });
  return { documentId: id, entryId };
}

for (const scenario of [
  { title: "includes both sides of an earlier void", reversalDate: "2026-07-02", opening: "200", closing: "230" },
  { title: "keeps the original when its reversal is after the cutoff", reversalDate: "2026-07-20", opening: "300", closing: "330" },
]) test(`the first statement opening ${scenario.title}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Bank controller", "admin");
    const ctx = { orgId: org.orgId, userId: actorId };
    await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD'
      where id=${org.accounts.bank} and org_id=${org.orgId}`);
    const mistaken = await deposit(org, actorId, "100", "2026-07-01");
    const correction = await requestDocumentVoid({ ...mistaken, orgId: org.orgId, actorId,
      reversalDate: scenario.reversalDate, reason: "Correct duplicate opening deposit", source: "api" });
    assert.equal(correction.status, "voided");
    await deposit(org, actorId, "200", "2026-07-03");
    await deposit(org, actorId, "30", org.date);
    const balance = (await db.execute<{ amount: string }>(sql`
      select sum(l.txn_amount)::text as amount from journal_lines l
      join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      where l.org_id=${org.orgId} and l.account_id=${org.accounts.bank}
        and e.book_id=${org.bookId} and e.status in ('posted','reversed')
        and e.posting_date <= ${org.date}`)).rows[0]!.amount;
    assert.equal(balance, `${scenario.closing}.0000`);
    await importStatement({ accountId: org.accounts.bank, source: "manual", currency: "CAD",
      statementDate: org.date, openingBalance: scenario.opening, closingBalance: scenario.closing,
      lines: [{ postedOn: org.date, amount: "30", description: "Current deposit", bankTransactionId: "current-deposit" }],
    }, ctx);
    const recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: scenario.closing }, ctx);
    assert.equal((await autoMatch(recon.id, ctx)).matched, 1);
    const totals = await reconciliationTotals(recon.id, ctx);
    assert.equal(totals.clearedBalance, `${scenario.closing}.0000`, "the opening must retain the controlled reversal history through the cutoff");
    assert.equal(totals.difference, "0.0000");
    assert.deepEqual(await markReconciled(recon.id, ctx), { journalLinesReconciled: 1 });
    const signoff = (await db.execute<{ changes: { openingCarriedForward: string } }>(sql`
      select changes from audit_log where org_id=${org.orgId} and row_id=${recon.id}
        and table_name='reconciliations' and action='approve'`)).rows[0]!;
    assert.equal(signoff.changes.openingCarriedForward, `${scenario.opening}.0000`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

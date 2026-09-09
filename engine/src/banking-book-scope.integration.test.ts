import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { runContinuousCloseAgent } from "./continuous-close.ts";
import { db, withOrgTransaction } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import { autoMatch, createMatch, createMatchWithJournal, importStatement, markReconciled, reconciliationTotals, startReconciliation } from "./banking.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
  bookId = org.bookId,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId},
         ${`BANK-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Bank reconciliation ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineIds: string[] = [];
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      const offsetAmount = fromUnits(-toUnits(amount));
      lineNumber += 1;
      const bankLineId = randomUUID();
      bankLineIds.push(bankLineId);
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${bankLineId}, ${org.orgId}, ${entryId}, ${lineNumber},
           ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD',
           ${amount}, 1, ${label})
      `);
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${org.orgId}, ${entryId}, ${lineNumber}, ${org.accounts.adjustment},
           ${org.subsidiaryId}, ${offsetAmount}, 'CAD',
           ${offsetAmount}, 1, ${label})
      `);
    }
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLineIds;
  });
}

for (const scenario of ["manual parallel books", "automatic secondary book", "cleared parallel books", "sign-off secondary book"] as const) {
  test(`bank reconciliation: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD' where org_id=${org.orgId} and id=${org.accounts.bank}`);
      const secondary = randomUUID();
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${secondary},${org.orgId},'TAX','Tax',false,true,true)`);
      const primaryLines = await postBankJournal(org, actor, ["100"], "primary");
      const taxLines = await postBankJournal(org, actor, ["100"], "secondary", secondary);
      const amount = scenario === "manual parallel books" || scenario === "cleared parallel books" ? "200" : "100";
      await importStatement({ accountId: org.accounts.bank, source: "manual", currency: "CAD", statementDate: org.date, closingBalance: amount,
        lines: [{ postedOn: org.date, amount, description: "One bank deposit", bankTransactionId: "one-deposit" }] }, ctx);
      const statementLineId = (await db.execute<{ id: string }>(sql`select id from bank_statement_lines where org_id=${org.orgId} and bank_transaction_id='one-deposit'`)).rows[0]!.id;
      const recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: amount }, ctx);
      if (scenario === "manual parallel books") {
        await assert.rejects(createMatch({ reconciliationId: recon.id, statementLineId, journalLineIds: [...primaryLines, ...taxLines] }, ctx), /book|eligible|available/);
        assert.equal((await db.execute(sql`select id from reconciliation_matches where org_id=${org.orgId}`)).rows.length, 0);
      } else if (scenario === "automatic secondary book") {
        // Claim the primary representation, then import a second physical
        // deposit. The tax representation cannot supply its missing journal.
        await createMatch({ reconciliationId: recon.id, statementLineId, journalLineIds: primaryLines }, ctx);
        await importStatement({ accountId: org.accounts.bank, source: "manual", currency: "CAD", statementDate: org.date,
          lines: [{ postedOn: org.date, amount: "100", description: "Another deposit", bankTransactionId: "second-deposit" }] }, ctx);
        assert.equal((await autoMatch(recon.id, ctx)).matched, 0);
      } else if (scenario === "cleared parallel books") {
        for (const journalLineId of [...primaryLines, ...taxLines]) {
          await db.execute(sql`insert into reconciliation_matches(org_id,reconciliation_id,statement_line_id,journal_line_id,matched_by,created_by)
            values(${org.orgId},${recon.id},${statementLineId},${journalLineId},'manual',${actor})`);
        }
        await db.execute(sql`update bank_statement_lines set match_status='matched' where org_id=${org.orgId} and id=${statementLineId}`);
        assert.equal((await reconciliationTotals(recon.id, ctx)).clearedBalance, "100.0000");
        await db.execute(sql`insert into ai_agent_policies(org_id,agent_key,enabled,materiality_threshold,analysis_settings)
          values(${org.orgId},'accounting',true,1,'{"rootCauseAnalysis":false,"recommendations":false,"narrative":false}')`);
        const scan = await runContinuousCloseAgent({ orgId: org.orgId, agentKey: "accounting", trigger: "manual", initiatedBy: actor });
        assert.equal(scan.status, "completed");
        const finding = (await db.execute<{ materiality: string }>(sql`select materiality from ai_work_items where org_id=${org.orgId} and finding_type='reconciliation_difference' and subject_id=${recon.id}`)).rows[0];
        assert.equal(finding?.materiality, "100.0000");
      } else {
        // Simulate a legacy match created before book controls existed.
        await db.execute(sql`insert into reconciliation_matches(org_id,reconciliation_id,statement_line_id,journal_line_id,matched_by,created_by)
          values(${org.orgId},${recon.id},${statementLineId},${taxLines[0]},'manual',${actor})`);
        await db.execute(sql`update bank_statement_lines set match_status='matched' where org_id=${org.orgId} and id=${statementLineId}`);
        await assert.rejects(markReconciled(recon.id, ctx), /book|matches fail/);
        assert.notEqual((await db.execute(sql`select status from reconciliations where org_id=${org.orgId} and id=${recon.id}`)).rows[0]!.status, "signed_off");
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

test("a refused journal factory rolls back within an ambient transaction", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Bank operator", "admin");
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD' where org_id=${org.orgId} and id=${org.accounts.bank}`);
    await importStatement({ accountId: org.accounts.bank, source: "manual", currency: "CAD", statementDate: org.date,
      lines: [{ postedOn: org.date, amount: "100", description: "Deposit", bankTransactionId: "ambient-deposit" }] }, ctx);
    const statementLineId = (await db.execute<{ id: string }>(sql`select id from bank_statement_lines where org_id=${org.orgId}`)).rows[0]!.id;
    const recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100" }, ctx);
    await withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`update parties set display_name='Surviving banking caller' where org_id=${org.orgId} and id=${org.customerId}`);
      await assert.rejects(createMatchWithJournal({ reconciliationId: recon.id, statementLineId,
        createJournal: async () => (await postBankJournal(org, actor, ["99"], "ambient-failed"))[0]! }, ctx), /Selected journal lines total/);
      await createMatchWithJournal({ reconciliationId: recon.id, statementLineId,
        createJournal: async () => (await postBankJournal(org, actor, ["100"], "ambient-valid"))[0]! }, ctx);
    });
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n, 1);
    assert.equal((await db.execute(sql`select display_name from parties where org_id=${org.orgId} and id=${org.customerId}`)).rows[0]!.display_name, "Surviving banking caller");
    assert.equal((await reconciliationTotals(recon.id, ctx)).difference, "0.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

for (const policy of ["inactive", "nonposting", "ambiguous"] as const) {
  test(`bank reconciliation refuses ${policy} primary book`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank operator", "admin");
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD' where org_id=${org.orgId} and id=${org.accounts.bank}`);
      const recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: "0" }, ctx);
      if (policy === "ambiguous") await db.transaction(async tx => {
        // Deliberately reproduce legacy ambiguous data: ordinary SQL now
        // refuses adding another primary after reconciliation history exists.
        await tx.execute(sql`set local openbooks.migration=on`);
        await tx.execute(sql`insert into accounting_books(org_id,code,name,is_primary) values(${org.orgId},'ALSO_PRIMARY','Ambiguous primary',true)`);
      });
      else await db.execute(sql`update accounting_books set is_active=${policy !== 'inactive'},posts_gl=${policy !== 'nonposting'} where org_id=${org.orgId} and id=${org.bookId}`);
      await assert.rejects(reconciliationTotals(recon.id, ctx), /exactly one active primary posting book/);
      await assert.rejects(autoMatch(recon.id, ctx), /exactly one active primary posting book/);
      await assert.rejects(markReconciled(recon.id, ctx), /exactly one active primary posting book/);
      await assert.rejects(startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: "0" }, ctx), /exactly one active primary posting book/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

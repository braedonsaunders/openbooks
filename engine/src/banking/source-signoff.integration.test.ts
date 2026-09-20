import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  applySourceLineEvidence,
  discardReconciliation,
  refreshSourceReconciliationState,
  signOffFromSourceEvidence,
  sourceEvidencePolicyActive,
  startReconciliation,
} from "./banking.ts";
import { ensureCloseDefaults } from "../close/defaults.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Source-evidenced sign-off (0158): the mirror carries the source system's
 * cleared markers onto posted journal lines and signs reconcilable accounts
 * off through the source's reconciled date — never inventing statement
 * lines. Partially cleared accounts stay open with exact counts.
 */

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`SRC-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Source evidence ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${org.orgId}, ${entryId}, ${lineNumber}, ${org.accounts.bank},
           ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1, ${label})
      `);
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${org.orgId}, ${entryId}, ${lineNumber}, ${org.accounts.adjustment},
           ${org.subsidiaryId}, ${fromUnits(-toUnits(amount))}, 'CAD',
           ${fromUnits(-toUnits(amount))}, 1, ${label})
      `);
    }
    await tx.execute(sql`
      update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}
    `);
    return entryId;
  });
}

async function clearedCount(orgId: string, accountId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select count(*) as n from journal_lines
     where org_id = ${orgId} and account_id = ${accountId} and source_cleared_date is not null
  `)).rows[0]!.n);
}

test("source evidence policy defaults on and seeds through close defaults", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    assert.equal(await sourceEvidencePolicyActive(org.orgId), true);
    await ensureCloseDefaults(org.orgId, actor);
    const row = (await db.execute<{ code: string; is_active: boolean }>(sql`
      select code, is_active from close_policies where org_id = ${org.orgId} and code = 'source-reconciliation-evidence'
    `)).rows[0]!;
    assert.equal(row?.code, "source-reconciliation-evidence");
    assert.equal(row?.is_active, true);
    assert.equal(await sourceEvidencePolicyActive(org.orgId), true);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("applySourceLineEvidence stamps unanimous groups and skips the rest", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    const full = await postBankJournal(org, actor, ["100", "50"], "full");
    const mixed = await postBankJournal(org, actor, ["25", "30"], "mixed");
    const result = await applySourceLineEvidence(org.orgId, "test-connector", [
      {
        entryId: full,
        lines: [
          { accountId: org.accounts.bank, cleared: true, clearedDate: org.date },
          { accountId: org.accounts.bank, cleared: true, clearedDate: org.date },
        ],
      },
      {
        entryId: mixed,
        lines: [
          { accountId: org.accounts.bank, cleared: true, clearedDate: org.date },
          { accountId: org.accounts.bank, cleared: false, clearedDate: null },
        ],
      },
    ]);
    assert.equal(result.entries, 2);
    // The unanimous bank group stamps both legs; the mixed bank group stamps
    // neither (one contributing source line is uncleared). Offset legs are
    // never evidence input: their accounts are not reconcilable.
    assert.equal(result.linesStamped, 2);
    assert.equal(await clearedCount(org.orgId, org.accounts.bank), 2);
    assert.equal(await clearedCount(org.orgId, org.accounts.adjustment), 0);
    // Evidence without a date, and blank connectors, fail closed.
    await assert.rejects(
      applySourceLineEvidence(org.orgId, "test-connector", [
        { entryId: full, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: null }] },
      ]),
      /clearedDate|date/i,
    );
    await assert.rejects(
      applySourceLineEvidence(org.orgId, "  ", [
        { entryId: full, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }] },
      ]),
      /connector/i,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("signOffFromSourceEvidence signs off fully-cleared accounts without statements", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    const entry = await postBankJournal(org, actor, ["308", "21"], "aug");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      {
        entryId: entry,
        lines: [
          { accountId: org.accounts.bank, cleared: true, clearedDate: org.date },
          { accountId: org.accounts.bank, cleared: true, clearedDate: org.date },
        ],
      },
    ]);
    await refreshSourceReconciliationState(org.orgId, "test-connector");
    const out = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(out.signed, true);
    assert.equal(out.signed && out.clearedLines, 2);
    const row = (await db.execute<{ status: string; evidence_kind: string; evidence_connector: string }>(sql`
      select status, evidence_kind, evidence_connector from reconciliations
       where id = ${out.signed ? out.reconciliationId : null} and org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(row.status, "signed_off");
    assert.equal(row.evidence_kind, "source");
    assert.equal(row.evidence_connector, "test-connector");
    // No statement line was invented to support the sign-off.
    assert.equal(
      Number((await db.execute<{ n: string }>(sql`select count(*) as n from bank_statement_lines where org_id = ${org.orgId}`)).rows[0]!.n),
      0,
    );
    // The cleared lines carry the reconciliation stamp.
    assert.equal(
      Number((await db.execute<{ n: string }>(sql`
        select count(*) as n from journal_lines
         where org_id = ${org.orgId} and reconciliation_id = ${out.signed ? out.reconciliationId : null}`)).rows[0]!.n),
      2,
    );
    // A rerun through the same date is already covered, not a second row.
    const again = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(again.signed, false);
    assert.equal(!again.signed && again.reason, "already-covered");
    assert.equal(
      Number((await db.execute<{ n: string }>(sql`
        select count(*) as n from reconciliations where org_id = ${org.orgId} and account_id = ${org.accounts.bank}`)).rows[0]!.n),
      1,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("partially-cleared accounts stay open with exact counts", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    const cleared = await postBankJournal(org, actor, ["100"], "cleared");
    await postBankJournal(org, actor, ["25"], "open");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      { entryId: cleared, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }] },
    ]);
    const state = await refreshSourceReconciliationState(org.orgId, "test-connector");
    assert.equal(state.length, 1);
    assert.equal(state[0]!.clearedLines, 1);
    assert.equal(state[0]!.unclearedLines, 1);
    assert.equal(state[0]!.reconciledThrough, org.date);
    const out = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(out.signed, false);
    assert.equal(!out.signed && out.reason, "partially-cleared");
    assert.equal(!out.signed && out.clearedLines, 1);
    assert.equal(!out.signed && out.unclearedLines, 1);
    assert.equal(
      Number((await db.execute<{ n: string }>(sql`select count(*) as n from reconciliations where org_id = ${org.orgId}`)).rows[0]!.n),
      0,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("source sign-off advances through later dates and yields to open sessions", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    const entry = await postBankJournal(org, actor, ["100"], "first");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      { entryId: entry, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }] },
    ]);
    await refreshSourceReconciliationState(org.orgId, "test-connector");
    const first = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(first.signed, true);
    assert.equal(first.signed && first.advanced, false);
    // An open statement session blocks the mirror from signing behind it.
    const session = await startReconciliation(
      { accountId: org.accounts.bank, throughDate: "2099-01-01", statementBalance: "100" },
      ctx,
    );
    const laterEntry = await postBankJournal(org, actor, ["50"], "later");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      { entryId: laterEntry, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: "2099-01-01" }] },
    ]);
    await refreshSourceReconciliationState(org.orgId, "test-connector");
    const blocked = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(blocked.signed, false);
    assert.equal(!blocked.signed && blocked.reason, "open-session");
    await discardReconciliation(session.id, ctx);
    const second = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(second.signed, true);
    assert.equal(second.signed && second.advanced, true);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("source sign-off refuses without evidence and when the policy is off", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    await postBankJournal(org, actor, ["100"], "unstamped");
    const noEvidence = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(noEvidence.signed, false);
    assert.equal(!noEvidence.signed && noEvidence.reason, "no-evidence");
    await ensureCloseDefaults(org.orgId, actor);
    await db.execute(sql`
      update close_policies set is_active = false
       where org_id = ${org.orgId} and code = 'source-reconciliation-evidence'`);
    assert.equal(await sourceEvidencePolicyActive(org.orgId), false);
    const disabled = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
    assert.equal(disabled.signed, false);
    assert.equal(!disabled.signed && disabled.reason, "policy-disabled");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  applySourceLineEvidence,
  refreshSourceReconciliationState,
  signOffFromSourceEvidence,
} from "./banking.ts";
import { ensureCloseDefaults, refreshCloseRun, startCloseRun } from "./close.ts";
import { db } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

/**
 * Close readiness and source evidence (0158): a source-evidenced sign-off
 * satisfies bank-unreconciled exactly like a statement sign-off while the
 * policy is on; open reconcilable accounts are named with cleared/uncleared
 * counts; turning the policy off returns readiness to statement-only.
 */

const enabled = Boolean(process.env.OPENBOOKS_DB_URL);

async function bankEntry(
  org: ScratchOrg,
  actor: string,
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
         ${`CR-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Close readiness ${label}`}, 'draft', 'manual', ${actor}, ${actor})
    `);
    let n = 0;
    for (const amount of bankAmounts) {
      n += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entryId}, ${n}, ${org.accounts.bank},
           ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1)
      `);
      n += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entryId}, ${n}, ${org.accounts.adjustment},
           ${org.subsidiaryId}, ${`-${amount}`}, 'CAD', ${`-${amount}`}, 1)
      `);
    }
    await tx.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    return entryId;
  });
}

async function periodEnd(orgId: string, periodId: string): Promise<string> {
  return (await db.execute<{ ends_on: string }>(sql`
    select ends_on::text from accounting_periods where id = ${periodId} and org_id = ${orgId}
  `)).rows[0]!.ends_on;
}

async function bankException(orgId: string, runId: string): Promise<{ count: number; accounts: { number: string | null; clearedLines: number; unclearedLines: number }[] } | null> {
  await refreshCloseRun(orgId, runId);
  const row = (await db.execute<{ details: { count: number; accounts?: { number: string | null; clearedLines: number; unclearedLines: number }[] } }>(sql`
    select details from close_exceptions
     where org_id = ${orgId} and run_id = ${runId} and code = 'bank-unreconciled' and status = 'open'
  `)).rows[0];
  if (!row) return null;
  return { count: row.details.count, accounts: row.details.accounts ?? [] };
}

async function setup(): Promise<{ org: ScratchOrg; actor: string; endsOn: string }> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Close reviewer", "admin");
  await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
  return { org, actor, endsOn: await periodEnd(org.orgId, org.periodId) };
}

test("bank-unreconciled names open accounts with cleared counts", { skip: !enabled }, async () => {
  const { org, actor } = await setup();
  try {
    const cleared = await bankEntry(org, actor, ["100"], "open-cleared");
    const open = await bankEntry(org, actor, ["25"], "open-uncleared");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      { entryId: cleared, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }] },
      { entryId: open, lines: [{ accountId: org.accounts.bank, cleared: false, clearedDate: null }] },
    ]);
    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId: actor });
    const exception = await bankException(org.orgId, runId);
    assert.ok(exception, "bank-unreconciled is open");
    assert.equal(exception.count, 1);
    assert.equal(exception.accounts.length, 1);
    // One bank line carries source evidence; the other is open.
    assert.equal(exception.accounts[0]!.clearedLines, 1);
    assert.equal(exception.accounts[0]!.unclearedLines, 1);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a source-evidenced sign-off satisfies readiness like a statement one", { skip: !enabled }, async () => {
  const { org, actor, endsOn } = await setup();
  try {
    const entry = await bankEntry(org, actor, ["308", "21"], "covered");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      {
        entryId: entry,
        lines: [
          { accountId: org.accounts.bank, cleared: true, clearedDate: endsOn },
          { accountId: org.accounts.bank, cleared: true, clearedDate: endsOn },
        ],
      },
    ]);
    await refreshSourceReconciliationState(org.orgId, "test-connector");
    const signed = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, { orgId: org.orgId, userId: actor });
    assert.equal(signed.signed, true);
    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId: actor });
    assert.equal(await bankException(org.orgId, runId), null);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("readiness returns to statement-only when the policy is off", { skip: !enabled }, async () => {
  const { org, actor, endsOn } = await setup();
  try {
    const entry = await bankEntry(org, actor, ["100"], "policy");
    await applySourceLineEvidence(org.orgId, "test-connector", [
      { entryId: entry, lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: endsOn }] },
    ]);
    await refreshSourceReconciliationState(org.orgId, "test-connector");
    const signed = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, { orgId: org.orgId, userId: actor });
    assert.equal(signed.signed, true);
    await ensureCloseDefaults(org.orgId, actor);
    await db.execute(sql`
      update close_policies set is_active = false where org_id = ${org.orgId} and code = 'source-reconciliation-evidence'`);
    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId: actor });
    const exception = await bankException(org.orgId, runId);
    assert.ok(exception, "source sign-offs stop satisfying readiness when the policy is off");
    assert.equal(exception.count, 1);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

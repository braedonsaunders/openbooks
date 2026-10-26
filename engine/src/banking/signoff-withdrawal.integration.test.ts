import { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  createMatch,
  importStatement,
  markReconciled,
  startReconciliation,
  withdrawReconciliationSignOff,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  amount: string,
  date: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`DEP-${entryId.slice(0, 8)}`}, ${date},
              ${org.periodId}, 'Deposit', 'draft', 'manual', ${actorId}, ${actorId})`);
    const offset = amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
    const [bankLine] = await tx.execute<{ id: string }>(
      sql`
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1, 'deposit'),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId}, ${offset}, 'CAD', ${offset}, 1, 'deposit')
      returning id`,
      "objects",
    );
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}`);
    return bankLine!.id;
  });
}

async function signedSession(
  org: ScratchOrg,
  ctx: { orgId: string; userId: string; allowedSubsidiaryIds: null },
  actor: string,
) {
  const journal = await postBankJournal(org, actor, "250.00", org.date);
  const content = `date,amount,description,bank_transaction_id\n${org.date},250.00,"Deposit",dep-1\n`;
  const imported = await importStatement(
    {
      accountId: org.accounts.bank,
      source: "csv",
      statementDate: org.date,
      currency: "CAD",
      lines: [
        {
          postedOn: org.date,
          amount: "250.00",
          description: "Deposit",
          bankTransactionId: "dep-1",
        },
      ],
      sourceEvidence: {
        content,
        filename: "statement.csv",
        contentType: "text/csv",
        csvMapping: {
          date: 0,
          amount: 1,
          description: 2,
          bankTransactionId: 3,
        },
      },
    },
    ctx,
  );
  const [line] = await db.execute<{ id: string }>(
    sql`
    select id from bank_statement_lines where org_id = ${org.orgId} and statement_id = ${imported.statementId!}`,
    "objects",
  );
  const recon = await startReconciliation(
    {
      accountId: org.accounts.bank,
      throughDate: org.date,
      statementBalance: "250.00",
    },
    ctx,
  );
  await createMatch(
    {
      reconciliationId: recon.id,
      statementLineIds: [line!.id],
      journalLineIds: [journal],
    },
    ctx,
  );
  await markReconciled(recon.id, ctx);
  return { reconId: recon.id, journal };
}

test(
  "a signed-off reconciliation is withdrawn with a reason only while Banking is open for its period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(
        sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`,
      );
      const ctx = {
        orgId: org.orgId,
        userId: actor,
        allowedSubsidiaryIds: null,
      };
      const { reconId, journal } = await signedSession(org, ctx, actor);

      await assert.rejects(
        withdrawReconciliationSignOff(reconId, "too short", ctx),
        /10-500 character reason/,
      );

      // A closed Banking period keeps signed history immutable and names the reopen.
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "banking",
        state: "soft_closed",
        actorId: actor,
        reason: "Month-end close",
      });
      await assert.rejects(
        withdrawReconciliationSignOff(reconId, "Late deposit belongs in this period", ctx),
        /Banking is closed for P07 FY2026 — request a controlled reopen of Banking/,
      );
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "banking",
        state: "open",
        actorId: actor,
        reason: "Correct a late deposit",
      });

      const result = await withdrawReconciliationSignOff(
        reconId,
        "Late deposit belongs in this period",
        ctx,
      );
      assert.equal(result.journalLinesReleased, 1);
      assert.equal(result.status, "balanced", "matches survive, so the session still foots");
      const session = (
        await db.execute<{ status: string; signed_off_at: string | null }>(
          sql`
      select status, signed_off_at::text from reconciliations where id = ${reconId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(session, { status: "balanced", signed_off_at: null });
      const line = (
        await db.execute<{
          reconciled_at: string | null;
          reconciliation_id: string | null;
        }>(
          sql`
      select reconciled_at::text, reconciliation_id::text from journal_lines where id = ${journal}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(line, { reconciled_at: null, reconciliation_id: null });
      const audit = await db.execute<{
        changes: {
          operation: string;
          reason: string;
          before: { status: string };
        };
      }>(
        sql`
      select changes from audit_log where org_id = ${org.orgId} and table_name = 'reconciliations' and row_id = ${reconId}
       and changes->>'operation' = 'withdraw_sign_off'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.changes.reason, "Late deposit belongs in this period");
      assert.equal(audit[0]!.changes.before.status, "signed_off");

      // Re-signing restamps the same evidence.
      const resigned = await markReconciled(reconId, ctx);
      assert.equal(
        resigned.status,
        "signed_off",
        "The zero-gate submission must complete its native outcome",
      );
      if (resigned.status !== "signed_off")
        throw new Error("The zero-gate submission unexpectedly awaits approval.");
      assert.equal(resigned.journalLinesReconciled, 1);

      // An unsigned session building on the sign-off must go first.
      const nextDay = new Date(Date.parse(`${org.date}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: nextDay,
          statementBalance: "250.00",
        },
        ctx,
      );
      await assert.rejects(
        withdrawReconciliationSignOff(reconId, "Late deposit belongs in this period", ctx),
        /Discard the open reconciliation through/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the stamp a sign-off places cannot be cleared without the governed withdrawal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(
        sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`,
      );
      const ctx = {
        orgId: org.orgId,
        userId: actor,
        allowedSubsidiaryIds: null,
      };
      const { journal } = await signedSession(org, ctx, actor);
      await assert.rejects(
        db.execute(
          sql`update journal_lines set reconciled_at = null, reconciliation_id = null where id = ${journal}`,
        ),
        (error: unknown) => errorChainMatches(error, /reconciliation evidence is append-only/),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

// Exercise the same native Flow composition installed by application entry points.
before(async () => {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
});

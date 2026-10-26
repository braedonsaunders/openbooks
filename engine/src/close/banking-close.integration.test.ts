import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import {
  applySourceLineEvidence,
  createMatch,
  excludeStatementLine,
  importStatement,
  markReconciled,
  refreshSourceReconciliationState,
  signOffFromSourceEvidence,
  startReconciliation,
} from "../banking/banking.ts";
import { ensureCloseDefaults } from "./defaults.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  auditBankingModuleClose,
  bankingCloseStatus,
  bankingUnmatchedStatementLines,
  evaluateBankingModuleClose,
} from "./banking-close.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
  postingDate: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BANK-${label}-${entryId.slice(0, 8)}`}, ${postingDate}, ${org.periodId},
         ${`Bank close-gate ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineIds: string[] = [];
    let lineNumber = 0;
    for (const amount of bankAmounts) {
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
           ${org.subsidiaryId}, ${`-${amount}`}, 'CAD',
           ${`-${amount}`}, 1, ${label})
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

async function periodEndsOn(org: ScratchOrg): Promise<{ startsOn: string; endsOn: string }> {
  const row = (
    await db.execute<{ starts_on: string; ends_on: string }>(
      sql`
    select starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}
  `,
      "objects",
    )
  )[0]!;
  return { startsOn: row.starts_on, endsOn: row.ends_on };
}

async function makeReconcilable(org: ScratchOrg): Promise<void> {
  await db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
}

test(
  "banking close shows each account and requires an acknowledgement for unsigned reconciliations",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const { startsOn, endsOn } = await periodEndsOn(org);
      await makeReconcilable(org);
      await postBankJournal(org, actor, ["100"], "opening", startsOn);
      const periodLines = await postBankJournal(org, actor, ["30"], "period", org.date);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: org.date,
          openingBalance: "100",
          closingBalance: "130",
          lines: [
            {
              postedOn: org.date,
              amount: "30",
              description: "Period deposit",
              bankTransactionId: `gate-period-deposit-${org.orgId}`,
            },
          ],
        },
        ctx,
      );
      // Deliberately unmatched: the session sits in progress with a difference.
      await startReconciliation(
        { accountId: org.accounts.bank, throughDate: endsOn, statementBalance: "130" },
        ctx,
      );
      assert.deepEqual(periodLines.length, 1);

      const statuses = await bankingCloseStatus(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0]?.status, "in_progress");
      assert.notEqual(statuses[0]?.difference, "0.0000");
      assert.equal(statuses[0]?.stale, false);

      await assert.rejects(
        evaluateBankingModuleClose(org.orgId, {
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
        }),
        (error: unknown) =>
          error instanceof CloseError &&
          /requires an explicit acknowledgement reason/.test(error.message) &&
          /in progress through/.test(error.message) &&
          /difference/.test(error.message),
        "an unsigned reconciliation refuses a close without acknowledgement",
      );

      const evaluation = await evaluateBankingModuleClose(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
        acknowledgement: "Controller accepts the unmatched period deposit; it clears next period.",
      });
      assert.equal(evaluation.issues.length, 1);
      assert.equal(evaluation.strict, false);
      await auditBankingModuleClose(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
        reason: "Banking month-end close",
        acknowledgement: "Controller accepts the unmatched period deposit; it clears next period.",
        evaluation,
      });
      const event = (
        await db.execute<{ payload: Record<string, unknown> }>(
          sql`
        select payload from close_events
         where org_id = ${org.orgId} and event_type = 'period.banking_close_acknowledged'
         order by at desc limit 1
      `,
          "objects",
        )
      )[0]?.payload as
        { acknowledgement?: string; accounts?: Array<{ status?: string }> } | undefined;
      assert.equal(
        event?.acknowledgement,
        "Controller accepts the unmatched period deposit; it clears next period.",
      );
      assert.equal(event?.accounts?.[0]?.status, "in_progress");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a strict org policy refuses banking close while reconciliations are unsigned",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const { endsOn } = await periodEndsOn(org);
      await makeReconcilable(org);
      await postBankJournal(org, actor, ["100"], "activity", org.date);
      await startReconciliation(
        { accountId: org.accounts.bank, throughDate: endsOn, statementBalance: "80" },
        ctx,
      );
      await db.execute(sql`
        insert into close_policies
          (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
        values (${org.orgId}, 'bank-signed-reconciliation', 'Signed bank reconciliations',
                'Banking closes only over signed-off reconciliations', 'review',
                '{"requireSignedReconciliation": true}'::jsonb, true, ${actor}, ${actor})
      `);

      await assert.rejects(
        evaluateBankingModuleClose(org.orgId, {
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
          acknowledgement: "Controller accepts; will sign off next period.",
        }),
        (error: unknown) =>
          error instanceof CloseError &&
          /cannot close Banking/.test(error.message) &&
          /sign off each account/.test(error.message),
        "the strict policy refuses even an acknowledged close",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a covering sign-off closes without acknowledgement; stale sign-off warns",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const { startsOn, endsOn } = await periodEndsOn(org);
      await makeReconcilable(org);
      await postBankJournal(org, actor, ["100"], "opening", startsOn);
      const periodLines = await postBankJournal(org, actor, ["30"], "period", org.date);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: org.date,
          openingBalance: "100",
          closingBalance: "130",
          lines: [
            {
              postedOn: org.date,
              amount: "30",
              description: "Period deposit",
              bankTransactionId: `gate-signed-deposit-${org.orgId}`,
            },
          ],
        },
        ctx,
      );
      const statementLineId = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = ${`gate-signed-deposit-${org.orgId}`}
      `,
          "objects",
        )
      )[0]!.id;
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: endsOn, statementBalance: "130" },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: [statementLineId],
          journalLineIds: periodLines,
        },
        ctx,
      );
      await markReconciled(recon.id, ctx);

      const clean = await evaluateBankingModuleClose(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(clean.issues.length, 0);
      assert.equal(clean.accounts[0]?.status, "signed_off");

      // The ledger moves underneath the sign-off: a back-dated posting lands
      // after the sign-off timestamp, so the covering session reads stale.
      await postBankJournal(org, actor, ["50"], "late", org.date);
      const stale = await bankingCloseStatus(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(stale[0]?.status, "signed_off");
      assert.equal(stale[0]?.stale, true);
      assert.equal(stale[0]?.clearedEffect, "50.0000");

      await assert.rejects(
        evaluateBankingModuleClose(org.orgId, {
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
        }),
        /requires an explicit acknowledgement reason/,
        "a stale sign-off warns like an unsigned reconciliation",
      );
      const acknowledged = await evaluateBankingModuleClose(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
        acknowledgement:
          "Controller notes the late 50.00 back-dating; sign-off stands for the rest.",
      });
      assert.equal(acknowledged.issues.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source-evidenced sign-offs stop covering close when their policy is disabled",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const { endsOn } = await periodEndsOn(org);
      await makeReconcilable(org);
      const lineIds = await postBankJournal(org, actor, ["100"], "source-policy", org.date);
      const entryId = (
        await db.execute<{ entry_id: string }>(
          sql`
      select entry_id from journal_lines where org_id=${org.orgId} and id=${lineIds[0]}`,
          "objects",
        )
      )[0]!.entry_id;
      await applySourceLineEvidence(org.orgId, "test-connector", [
        {
          entryId,
          lines: [{ accountId: org.accounts.bank, cleared: true, clearedDate: endsOn }],
        },
      ]);
      await refreshSourceReconciliationState(org.orgId, "test-connector");
      const signed = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
      assert.equal(signed.signed, true);
      const before = await bankingCloseStatus(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(before[0]?.status, "signed_off");

      await ensureCloseDefaults(org.orgId, actor);
      await db.execute(sql`update close_policies set is_active=false
      where org_id=${org.orgId} and code='source-reconciliation-evidence'`);
      const after = await bankingCloseStatus(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(after[0]?.status, "none");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an account with activity but no reconciliation reports none and requires acknowledgement",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await makeReconcilable(org);
      await postBankJournal(org, actor, ["920"], "activity", org.date);

      const statuses = await bankingCloseStatus(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0]?.status, "none");

      await assert.rejects(
        evaluateBankingModuleClose(org.orgId, {
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
        }),
        /no reconciliation through the period/,
        "a missing reconciliation blocks a silent close",
      );
      const evaluation = await evaluateBankingModuleClose(org.orgId, {
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actor,
        acknowledgement:
          "First banking close before statement feeds; reconciliation starts next period.",
      });
      assert.equal(evaluation.issues.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "unmatched statement lines count the period's open lines on governed accounts",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      await makeReconcilable(org);
      await postBankJournal(org, actor, ["100"], "opening", org.date);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: org.date,
          openingBalance: "0",
          closingBalance: "80",
          lines: [
            {
              postedOn: org.date,
              amount: "30",
              description: "Period receipt",
              bankTransactionId: `m41-open-one-${org.orgId}`,
            },
            {
              postedOn: org.date,
              amount: "50",
              description: "Duplicate already booked elsewhere",
              bankTransactionId: `m41-open-two-${org.orgId}`,
            },
          ],
        },
        ctx,
      );
      const scope = { periodId: org.periodId, bookId: org.bookId };
      assert.equal(await bankingUnmatchedStatementLines(org.orgId, scope), 2);
      // Excluded lines leave the count: they need no match.
      const excludedId = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = ${`m41-open-two-${org.orgId}`}
      `,
          "objects",
        )
      )[0]!.id;
      await excludeStatementLine(excludedId, "duplicate of an earlier import", ctx);
      assert.equal(await bankingUnmatchedStatementLines(org.orgId, scope), 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

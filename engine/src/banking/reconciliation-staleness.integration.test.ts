import { installEngineSeams } from "../composition/install.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  createMatch,
  importStatement,
  markReconciled,
  priorPeriodLateEffect,
  reconciliationStaleness,
  startReconciliation,
} from "./banking.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

/**
 * A signed-off reconciliation goes STALE when ledger activity dated in its
 * period is posted after its sign-off, or when a line it matched is later
 * reversed. Staleness reads from the ledger at read time; the sign-off row
 * itself never changes.
 */

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
  postingDate: string,
): Promise<{ entryId: string; entryNumber: string; lineIds: string[] }> {
  const entryId = randomUUID();
  const entryNumber = `STALE-${label}-${entryId.slice(0, 8)}`;
  const lineIds: string[] = [];
  await db.transaction(async (tx) => {
    // The house draft -> posted path: the ledger trigger stamps posted_at, so
    // arrival order is wall-clock order — entries posted here after the
    // sign-off below read as late, entries posted before read as on time.
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${entryNumber}, ${postingDate}, ${org.periodId},
         ${`Staleness ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      const offset = fromUnits(-toUnits(amount));
      lineNumber += 1;
      const bankLineId = randomUUID();
      lineIds.push(bankLineId);
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
           ${org.subsidiaryId}, ${offset}, 'CAD',
           ${offset}, 1, ${label})
      `);
    }
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
  });
  return { entryId, entryNumber, lineIds };
}

async function signOffJulySession(
  org: ScratchOrg,
  actorId: string,
  label: string,
): Promise<{
  reconId: string;
  ctx: { orgId: string; userId: string; allowedSubsidiaryIds: null };
}> {
  installEngineSeams();
  const ctx = { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null };
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  const period = await postBankJournal(org, actorId, ["100"], `${label}-period`, "2026-07-10");
  await importStatement(
    {
      accountId: org.accounts.bank,
      source: "manual",
      currency: "CAD",
      statementDate: "2026-07-15",
      openingBalance: "0",
      closingBalance: "100",
      lines: [
        {
          postedOn: "2026-07-10",
          amount: "100",
          description: "July deposit",
          bankTransactionId: `stale-${label}-deposit`,
        },
      ],
    },
    ctx,
  );
  const statementLineId = (
    await db.execute<{ id: string }>(
      sql`
    select id from bank_statement_lines
     where org_id = ${org.orgId} and bank_transaction_id = ${`stale-${label}-deposit`}
  `,
      "objects",
    )
  )[0]!.id;
  const recon = await startReconciliation(
    { accountId: org.accounts.bank, throughDate: "2026-07-15", statementBalance: "100" },
    ctx,
  );
  await createMatch(
    {
      reconciliationId: recon.id,
      statementLineIds: [statementLineId],
      journalLineIds: period.lineIds,
    },
    ctx,
  );
  assert.deepEqual(await markReconciled(recon.id, ctx), {
    journalLinesReconciled: 1,
    status: "signed_off",
  });
  return { reconId: recon.id, ctx };
}

test(
  "late true-dated postings flag the signed-off session with the entries and their effect",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const { reconId, ctx } = await signOffJulySession(org, actor, "late");

      const receipt = await postBankJournal(org, actor, ["3500"], "late-receipt", "2026-07-10");
      const payment = await postBankJournal(org, actor, ["-4420"], "late-payment", "2026-07-12");

      const staleness = await reconciliationStaleness(reconId, ctx);
      assert.equal(staleness.stale, true);
      // Arrival order is wall-clock order: the earliest late posting dates
      // the staleness, read back from the ledger rather than the clock.
      const arrival = await db.execute<{ entry_number: string; day: string }>(
        sql`
        select entry_number, posted_at::date::text as day from journal_entries
         where org_id = ${org.orgId} and id in (${receipt.entryId}, ${payment.entryId})
      `,
        "objects",
      );
      const firstDay = arrival.map((row) => row.day).sort()[0]!;
      assert.equal(staleness.staleSince, firstDay);
      assert.equal(staleness.clearedEffect, "-920.0000");
      assert.deepEqual(
        staleness.lateEntries.map((entry) => entry.entryNumber).sort(),
        [receipt.entryNumber, payment.entryNumber].sort(),
      );
      const byNumber = new Map(staleness.lateEntries.map((entry) => [entry.entryNumber, entry]));
      assert.equal(byNumber.get(receipt.entryNumber)?.postingDate, "2026-07-10");
      assert.equal(byNumber.get(receipt.entryNumber)?.amount, "3500.0000");
      assert.equal(byNumber.get(receipt.entryNumber)?.postedBy, "Bank reviewer");
      assert.equal(byNumber.get(payment.entryNumber)?.postingDate, "2026-07-12");
      assert.equal(byNumber.get(payment.entryNumber)?.amount, "-4420.0000");
      assert.deepEqual(staleness.reversedMatches, []);

      // The late lines surface as outstanding ledger lines for the next
      // session: unreconciled, unmatched, and dated within its scope.
      const outstanding = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}
           and je.status in ('posted', 'reversed') and je.posting_date <= '2026-07-15'
           and jl.reconciled_at is null
           and not exists (select 1 from reconciliation_matches m
                            where m.journal_line_id = jl.id and m.org_id = jl.org_id)
           and jl.id = any(${sql.param([...receipt.lineIds, ...payment.lineIds])}::uuid[])
      `,
          "objects",
        )
      )[0]!.n;
      assert.equal(outstanding, 2);

      // February's session explains its opening difference from November's
      // late sign-off activity.
      assert.deepEqual(await priorPeriodLateEffect(org.accounts.bank, "2026-07-31", ctx), [
        { throughDate: "2026-07-15", amount: "-920.0000" },
      ]);
      assert.deepEqual(await priorPeriodLateEffect(org.accounts.bank, "2026-07-01", ctx), []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reversing a matched entry flags the signed-off session that relied on it",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const { reconId, ctx } = await signOffJulySession(org, actor, "reversed");

      const matched = (
        await db.execute<{ entry_id: string; entry_number: string }>(
          sql`
        select je.id as entry_id, je.entry_number
          from reconciliation_matches m
          join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where m.org_id = ${org.orgId} and m.reconciliation_id = ${reconId}
         limit 1
      `,
          "objects",
        )
      )[0]!;
      const mirrorId = randomUUID();
      const mirrorNumber = `STALE-reversal-${mirrorId.slice(0, 8)}`;
      await db.transaction(async (tx) => {
        // The ledger guard refuses a reversal without its posted mirror, so
        // the mirror posts first and the original is marked after.
        await tx.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin,
             reverses_entry_id, created_by, updated_by)
          values
            (${mirrorId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
             ${mirrorNumber}, '2026-07-22', ${org.periodId},
             'Reversal of matched July deposit', 'draft', 'manual',
             ${matched.entry_id}, ${actor}, ${actor})
        `);
        const lines = await tx.execute<{
          account_id: string;
          subsidiary_id: string;
          amount: string;
          currency: string;
          txn_amount: string;
        }>(
          sql`
          select account_id, subsidiary_id, amount, currency, txn_amount
            from journal_lines where entry_id = ${matched.entry_id} and org_id = ${org.orgId}
           order by line_number
        `,
          "objects",
        );
        let lineNumber = 0;
        for (const line of lines) {
          lineNumber += 1;
          const negated = fromUnits(-toUnits(line.amount));
          const negatedTxn = fromUnits(-toUnits(line.txn_amount));
          await tx.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate, memo)
            values
              (${org.orgId}, ${mirrorId}, ${lineNumber}, ${line.account_id},
               ${line.subsidiary_id}, ${negated}, ${line.currency},
               ${negatedTxn}, 1, 'reversal')
          `);
        }
        await tx.execute(sql`
          update journal_entries
             set status = 'posted', posted_by = ${actor}, updated_by = ${actor}
           where id = ${mirrorId} and org_id = ${org.orgId}
        `);
        await tx.execute(sql`
          update journal_entries
             set status = 'reversed', updated_by = ${actor}
           where id = ${matched.entry_id} and org_id = ${org.orgId}
        `);
      });

      const staleness = await reconciliationStaleness(reconId, ctx);
      assert.equal(staleness.stale, true);
      // The mirror posts after the sign-off, so the reversal dates the
      // staleness — read back from the ledger, not the clock.
      const mirrorDay = (
        await db.execute<{ day: string }>(
          sql`
        select posted_at::date::text as day from journal_entries
         where id = ${mirrorId} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0]!.day;
      assert.equal(staleness.staleSince, mirrorDay);
      assert.deepEqual(staleness.lateEntries, []);
      assert.equal(staleness.reversedMatches.length, 1);
      assert.equal(staleness.reversedMatches[0]?.entryNumber, matched.entry_number);
      assert.equal(staleness.reversedMatches[0]?.reversalNumber, mirrorNumber);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a signed-off session with no later activity is not stale",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const { reconId, ctx } = await signOffJulySession(org, actor, "clean");

      assert.deepEqual(await reconciliationStaleness(reconId, ctx), {
        stale: false,
        staleSince: null,
        lateEntries: [],
        reversedMatches: [],
        clearedEffect: "0.0000",
      });
      assert.deepEqual(await priorPeriodLateEffect(org.accounts.bank, "2026-07-31", ctx), []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

async function draftEntry(org: Awaited<ReturnType<typeof createScratchOrg>>, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${id}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${number}, ${org.date},
            ${org.periodId}, 'draft', 'manual')`);
  return id;
}

async function line(
  runner: Pick<typeof db, "execute">,
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  entryId: string,
  lineNumber: number,
  accountId: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  await runner.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${id}, ${org.orgId}, ${entryId}, ${lineNumber}, ${accountId}, ${org.subsidiaryId},
            ${amount}, 'CAD', ${amount}, 1)`);
  return id;
}

test("moving a line cannot strand its old entry unbalanced and then post it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    let a = "";
    let b = "";
    let moved = "";
    let bCredit = "";
    await db.transaction(async (tx) => {
      a = await draftEntry(org, "MOVE-A");
      b = await draftEntry(org, "MOVE-B");
      moved = await line(tx, org, a, 1, org.accounts.bank, "10");
      await line(tx, org, a, 2, org.accounts.cogs, "-10");
      await line(tx, org, b, 1, org.accounts.bank, "20");
      bCredit = await line(tx, org, b, 2, org.accounts.cogs, "-20");
    });

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`set constraints all immediate`);
        await tx.execute(sql`set constraints all deferred`);
        await tx.execute(sql`update journal_lines set entry_id = ${b}, line_number = 3 where id = ${moved}`);
        await tx.execute(sql`update journal_lines set amount = '-30', txn_amount = '-30' where id = ${bCredit}`);
        await tx.execute(sql`update journal_entries set status = 'posted' where id = ${a}`);
        await tx.execute(sql`set constraints all immediate`);
      }),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /does not balance/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );

    const state = (await db.execute(sql`
      select status, (select sum(amount) from journal_lines where entry_id = ${a})::text as balance
        from journal_entries where id = ${a}`)) as unknown as { rows: { status: string; balance: string }[] };
    assert.deepEqual(state.rows[0], { status: "draft", balance: "0.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posted status independently refuses entries with fewer than two lines", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const entryId = await draftEntry(org, "EMPTY-POST");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`update journal_entries set status = 'posted' where id = ${entryId}`);
        await tx.execute(sql`set constraints all immediate`);
      }),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /at least two lines/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "reversed ledger history is amendable only through the guarded open-period path",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const originalId = await draftEntry(org, "REV-AMEND-ORIGINAL");
      let originalDebit = "";
      await db.transaction(async (tx) => {
        originalDebit = await line(
          tx,
          org,
          originalId,
          1,
          org.accounts.bank,
          "10",
        );
        await line(tx, org, originalId, 2, org.accounts.cogs, "-10");
        await tx.execute(
          sql`update journal_entries set status = 'posted' where id = ${originalId}`,
        );
        await tx.execute(sql`set constraints all immediate`);
      });

      const reversalId = await draftEntry(org, "REV-AMEND-REVERSAL");
      await db.execute(sql`
        update journal_entries
           set reverses_entry_id = ${originalId}
         where id = ${reversalId}
      `);
      let reversalCredit = "";
      await db.transaction(async (tx) => {
        reversalCredit = await line(
          tx,
          org,
          reversalId,
          1,
          org.accounts.bank,
          "-10",
        );
        await line(tx, org, reversalId, 2, org.accounts.cogs, "10");
        await tx.execute(
          sql`update journal_entries set status = 'posted' where id = ${reversalId}`,
        );
        await tx.execute(
          sql`update journal_entries set status = 'reversed' where id = ${originalId}`,
        );
        await tx.execute(sql`set constraints all immediate`);
      });

      await assert.rejects(
        db.execute(
          sql`update journal_lines set memo = 'unguarded' where id = ${originalDebit}`,
        ),
        (error: unknown) =>
          errorChainMatches(
            error,
            /lines of a reversed journal entry are immutable/,
          ),
      );

      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values (
          ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
          'gl', 'closed', 'Kernel reversed-history amendment test'
        )
      `);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = 'on'`);
          await tx.execute(
            sql`update journal_lines set memo = 'closed-period' where id = ${originalDebit}`,
          );
        }),
        (error: unknown) =>
          errorChainMatches(error, /period is closed for GL posting/),
      );

      await db.execute(sql`
        update period_locks
           set state = 'open', reopen_expires_at = now() + interval '1 hour'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend = 'on'`);
        await tx.execute(
          sql`update journal_lines set memo = 'controlled-pair-amendment' where id in (${originalDebit}, ${reversalCredit})`,
        );
        await tx.execute(sql`set constraints all immediate`);
      });

      const amended = await db.execute(sql`
        select je.status, jl.amount::text, jl.memo
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id
         where jl.id in (${originalDebit}, ${reversalCredit})
         order by jl.amount
      `);
      assert.deepEqual(amended.rows, [
        {
          status: "posted",
          amount: "-10.0000",
          memo: "controlled-pair-amendment",
        },
        {
          status: "reversed",
          amount: "10.0000",
          memo: "controlled-pair-amendment",
        },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source replay crosses only connector-owned historical locks",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const entryId = await draftEntry(org, "SOURCE-LOCK-REPLAY");
      let debitId = "";
      await db.transaction(async (tx) => {
        debitId = await line(tx, org, entryId, 1, org.accounts.bank, "10");
        await line(tx, org, entryId, 2, org.accounts.cogs, "-10");
        await tx.execute(
          sql`update journal_entries set status = 'posted' where id = ${entryId}`,
        );
        await tx.execute(sql`set constraints all immediate`);
      });
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values (
          ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
          'gl', 'closed', 'close.importedPeriodLockReason'
        )
      `);

      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = 'on'`);
          await tx.execute(
            sql`update journal_lines set memo = 'not-source-replay' where id = ${debitId}`,
          );
        }),
        (error: unknown) =>
          errorChainMatches(error, /period is closed for GL posting/),
      );

      await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend = 'on'`);
        await tx.execute(sql`set local openbooks.migration = 'on'`);
        await tx.execute(
          sql`update journal_lines set memo = 'exact-source-replay' where id = ${debitId}`,
        );
      });

      await db.execute(sql`
        update period_locks
           set reason = 'controller_close'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = 'on'`);
          await tx.execute(sql`set local openbooks.migration = 'on'`);
          await tx.execute(
            sql`update journal_lines set memo = 'controller-lock-bypass' where id = ${debitId}`,
          );
        }),
        (error: unknown) =>
          errorChainMatches(error, /period is closed for GL posting/),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("applications enforce independent base and transaction caps at deferred commit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const targetEntry = await draftEntry(org, "FX-TARGET");
    const sourceEntry = await draftEntry(org, "FX-SOURCE");
    const targetLine = randomUUID();
    const sourceLine = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${targetLine}, ${org.orgId}, ${targetEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '120', 'EUR', '100', '1.2', ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${targetEntry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-120', 'EUR', '-100', '1.2', null, false),
          (${sourceLine}, ${org.orgId}, ${sourceEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '-130', 'USD', '-80', '1.625', ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${sourceEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '130', 'USD', '80', '1.625', null, false)`);
      await tx.execute(sql`update journal_entries set status = 'posted' where id in (${targetEntry}, ${sourceEntry})`);
      await tx.execute(sql`set constraints all immediate`);
    });

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into applications
            (org_id, from_line_id, to_line_id, amount, source_amount,
             source_transaction_amount, source_transaction_currency,
             target_transaction_amount, target_transaction_currency,
             settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on)
          values (${org.orgId}, ${sourceLine}, ${targetLine}, '120', '130.0001',
                  '80', 'USD', '100', 'EUR', '1.25', 'manual', 'TEST-RATE', ${org.date})`);
        await tx.execute(sql`set constraints all immediate`);
      }),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /exceeds available amount on source line/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into applications
            (org_id, from_line_id, to_line_id, amount, source_amount,
             source_transaction_amount, source_transaction_currency,
             target_transaction_amount, target_transaction_currency,
             settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on)
          values (${org.orgId}, ${sourceLine}, ${targetLine}, '120', '130',
                  '80', 'USD', '100.0001', 'EUR', '1.25000125', 'manual', 'TEST-RATE', ${org.date})`);
        await tx.execute(sql`set constraints all immediate`);
      }),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /exceeds transaction amount on target line/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );
    const validApplication = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into applications
          (id, org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on)
        values (${validApplication}, ${org.orgId}, ${sourceLine}, ${targetLine}, '120', '130',
                '80', 'USD', '100', 'EUR', '1.25', 'manual', 'TEST-RATE', ${org.date})`);
      await tx.execute(sql`set constraints all immediate`);
    });
    await assert.rejects(
      db.execute(sql`update applications set settlement_rate_reference = 'CHANGED' where id = ${validApplication}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /application evidence is immutable/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

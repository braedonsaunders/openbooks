import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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

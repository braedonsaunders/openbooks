import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { importSettlementBatch, parseSquarePayout, postSettlementBatch } from "./psp-settlement.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Open the calendar month that contains today, cloned from the scratch org's period. */
async function ensureOpenPeriod(orgId: string, periodId: string): Promise<void> {
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id,
           extract(year from ${monthStart}::date)::int,
           extract(month from ${monthStart}::date)::int,
           to_char(${monthStart}::date, 'YYYY-MM'),
           ${monthStart}::date,
           (${monthStart}::date + interval '1 month - 1 day')::date, false
      from accounting_periods
     where id = ${periodId}
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

// A Square payout in the organization's base currency (CAD), so posting needs
// no payout-to-base rate. Entries: a card charge with its processing fee, a
// refund that returns part of the fee, and a fee entry. The payout nets to
// 100.00 − 2.90 − 15.00 + 0.44 − 3.00 = 79.54.
const payout = {
  id: "po_square_it_1",
  status: "PAID",
  arrival_date: "2026-07-10",
  amount_money: { amount: 7954, currency: "CAD" },
};
const entries = [
  {
    id: "pe_square_it_charge",
    payout_id: "po_square_it_1",
    type: "CHARGE",
    gross_amount_money: { amount: 10000, currency: "CAD" },
    fee_amount_money: { amount: -290, currency: "CAD" },
    net_amount_money: { amount: 9710, currency: "CAD" },
    type_charge_details: { payment_id: "pay_square_it_1" },
  },
  {
    id: "pe_square_it_refund",
    payout_id: "po_square_it_1",
    type: "REFUND",
    gross_amount_money: { amount: -1500, currency: "CAD" },
    fee_amount_money: { amount: 44, currency: "CAD" },
    net_amount_money: { amount: -1456, currency: "CAD" },
    type_refund_details: { payment_id: "pay_square_it_1" },
  },
  {
    id: "pe_square_it_fee",
    payout_id: "po_square_it_1",
    type: "FEE",
    gross_amount_money: { amount: -300, currency: "CAD" },
    net_amount_money: { amount: -300, currency: "CAD" },
  },
];

test(
  "a Square payout imports idempotently and posts balanced with its bank deposit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Square Tester", "admin");
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
      await ensureOpenPeriod(org.orgId, org.periodId);
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.adjustment,
        disputeAccountId: org.accounts.adjustment,
        fxAccountId: org.accounts.fxGainLoss,
        clearingAccountId: org.accounts.clearing,
      };
      const parsed = parseSquarePayout(payout, entries, org.date);

      const first = await importSettlementBatch(org.orgId, userId, parsed, accounts, null);
      assert.equal(first.created, true);
      // Re-importing the same payout converges on the same batch instead of
      // duplicating its deposit.
      const again = await importSettlementBatch(org.orgId, userId, parsed, accounts, null);
      assert.equal(again.created, false);
      assert.equal(again.batchId, first.batchId);

      const posted = await postSettlementBatch(org.orgId, first.batchId, userId, null);
      assert.ok(posted.entryId);

      const lines = await db.execute<{ account_id: string; amount: string }>(
        sql`
      select jl.account_id, jl.amount::text as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${org.orgId} and je.id = ${posted.entryId}`,
        "objects",
      );
      const total = lines.reduce(
        (sum, l) => sum + BigInt(Math.round(Number(l.amount) * 10_000)),
        0n,
      );
      assert.equal(total, 0n, "the posted entry balances");
      // The bank leg is the Square payout amount, 79.54 CAD.
      const bankLine = lines.find((l) => l.account_id === org.accounts.bank);
      assert.equal(bankLine?.amount, "79.5400");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

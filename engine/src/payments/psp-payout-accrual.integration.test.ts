import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { endOfMonth } from "../platform/civil-date.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  batchDepositTieout,
  importSettlementBatch,
  parseStripeBalanceTransactions,
  postSettlementBatch,
  reverseSettlementBatch,
} from "./psp-settlement.ts";
import { accruePayoutsInTransit } from "./psp-payout-accrual.ts";
import { createMatch, importStatement, startReconciliation } from "../banking/banking.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function ensureOpenPeriod(
  orgId: string,
  periodId: string,
  date = new Date().toISOString().slice(0, 10),
): Promise<void> {
  const [year, month] = date.split("-").map(Number) as [number, number, number];
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id, ${year}, ${month}, ${date.slice(0, 7)},
           ${`${year}-${String(month).padStart(2, "0")}-01`},
           ${endOfMonth(date)}, false
      from accounting_periods
     where id = ${periodId}
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

async function pullConfig(
  orgId: string,
  userId: string,
  bank: string,
  fee: string,
  fx: string,
  clearing: string,
): Promise<void> {
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, pull_enabled,
       default_bank_account_id, default_fee_account_id, default_dispute_account_id,
       default_fx_account_id, default_clearing_account_id,
       secrets, created_by, updated_by)
    values (${orgId}, 'stripe', 'Stripe', true, false, true,
            ${bank}, ${fee}, ${fee}, ${fx}, ${clearing},
            ${sealJson({ apiKey: "sk_test_accrual" }, { orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
}

/** Exact 4dp-decimal to integer units without float math. */
function units4(amount: string): bigint {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  const [whole, frac = ""] = digits.split(".");
  return BigInt(`${negative ? "-" : ""}${whole}${(frac + "0000").slice(0, 4)}`);
}

async function postedBatch(
  orgId: string,
  actor: string,
  payoutId: string,
  accounts: { bank: string; fee: string; clearing: string },
  settlementDate = "2026-07-10",
): Promise<string> {
  const parsed = parseStripeBalanceTransactions(
    [
      {
        id: `txn_${payoutId}`,
        type: "charge",
        amount: 10_000,
        fee: 290,
        net: 9_710,
        currency: "cad",
      },
    ],
    payoutId,
    settlementDate,
  );
  const imported = await importSettlementBatch(
    orgId,
    actor,
    parsed,
    {
      bankAccountId: accounts.bank,
      feeAccountId: accounts.fee,
      clearingAccountId: accounts.clearing,
    },
    null,
  );
  const posted = await postSettlementBatch(orgId, imported.batchId, actor, null);
  assert.ok(posted.entryId);
  return imported.batchId;
}

test(
  "deposit tie-out follows the bank reconciliation match, with the gap",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payout Clerk", "admin");
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
      await ensureOpenPeriod(org.orgId, org.periodId);
      await pullConfig(
        org.orgId,
        actor,
        org.accounts.bank,
        org.accounts.adjustment,
        org.accounts.fxGainLoss,
        org.accounts.clearing,
      );
      const batchId = await postedBatch(org.orgId, actor, "po_tieout_1", {
        bank: org.accounts.bank,
        fee: org.accounts.adjustment,
        clearing: org.accounts.clearing,
      });

      const untied = await batchDepositTieout(org.orgId, batchId, null);
      assert.equal(untied.status, "untied");
      assert.ok(untied.status === "untied" && untied.gapAmount === untied.netAmount);

      await db.execute(sql`
      update accounts set reconcilable = true, currency_restriction = 'CAD'
       where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const net = untied.status === "untied" ? untied.netAmount : "0";
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: "2026-07-10",
          openingBalance: "0",
          closingBalance: net,
          lines: [
            {
              postedOn: "2026-07-10",
              amount: net,
              description: "Stripe payout po_tieout_1",
              bankTransactionId: "tieout-deposit-1",
            },
          ],
        },
        ctx,
      );
      const statementLineId = (
        await db.execute<{ id: string }>(
          sql`
      select id from bank_statement_lines
       where org_id = ${org.orgId} and bank_transaction_id = 'tieout-deposit-1'
    `,
          "objects",
        )
      )[0]!.id;
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-07-10", statementBalance: net },
        ctx,
      );
      const bankLegs = (
        await db.execute<{ id: string }>(
          sql`
      select jl.id from journal_lines jl
        join psp_settlement_batches b on b.journal_entry_id = jl.entry_id and b.org_id = jl.org_id
       where jl.org_id = ${org.orgId} and b.id = ${batchId} and jl.account_id = ${org.accounts.bank}
    `,
          "objects",
        )
      ).map((row) => row.id);
      assert.ok(bankLegs.length > 0, "the posted batch carries a bank leg");
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: [statementLineId],
          journalLineIds: bankLegs,
        },
        ctx,
      );

      const tied = await batchDepositTieout(org.orgId, batchId, null);
      assert.equal(tied.status, "tied");
      assert.ok(tied.status === "tied");
      assert.equal(tied.depositLines.length, 1);
      assert.equal(tied.depositLines[0]!.bankTransactionId, "tieout-deposit-1");
      assert.equal(
        units4(tied.gapAmount ?? "999"),
        0n,
        "the deposit covers the payout net exactly",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "in-transit accrual posts a balanced reclass and reverses it next period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payout Clerk", "admin");
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
      await ensureOpenPeriod(org.orgId, org.periodId);
      await pullConfig(
        org.orgId,
        actor,
        org.accounts.bank,
        org.accounts.adjustment,
        org.accounts.fxGainLoss,
        org.accounts.clearing,
      );
      const batchId = await postedBatch(org.orgId, actor, "po_transit_1", {
        bank: org.accounts.bank,
        fee: org.accounts.adjustment,
        clearing: org.accounts.clearing,
      });

      const first = await accruePayoutsInTransit(org.orgId, "2026-07-15", actor, null);
      assert.equal(first.accrued.length, 1);
      assert.equal(first.reversed.length, 0);
      assert.equal(first.accrued[0]!.batchId, batchId);

      const legs = await db.execute<{ amount: string }>(
        sql`
      select l.amount::text as amount from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${org.orgId} and e.origin = 'accrual'
         and e.status in ('posted', 'reversed')
    `,
        "objects",
      );
      assert.ok(legs.length >= 2, "the accrual posts journal legs");
      const total = legs.reduce((sum, leg) => sum + units4(leg.amount), 0n);
      assert.equal(total, 0n, "accrual legs balance");

      // A rerun converges onto the stored accrual instead of double-booking.
      const rerun = await accruePayoutsInTransit(org.orgId, "2026-07-15", actor, null);
      assert.equal(rerun.accrued.length, 0);
      assert.equal(rerun.reversed.length, 0);

      // The next run reverses what came due and carries the presentation forward.
      const next = await accruePayoutsInTransit(org.orgId, "2026-07-16", actor, null);
      assert.equal(next.reversed.length, 1);
      const row = (
        await db.execute<{ status: string; reversal_entry_id: string | null }>(
          sql`
      select status, reversal_entry_id from psp_payout_accruals
       where org_id = ${org.orgId} and batch_id = ${batchId} and accrual_date = '2026-07-15'
    `,
          "objects",
        )
      )[0]!;
      assert.equal(row.status, "reversed");
      assert.ok(row.reversal_entry_id);

      const combined = await db.execute<{ amount: string }>(
        sql`
      select l.amount::text as amount from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${org.orgId} and e.origin = 'accrual'
         and e.status in ('posted', 'reversed')
    `,
        "objects",
      );
      const combinedTotal = combined.reduce((sum, leg) => sum + units4(leg.amount), 0n);
      assert.equal(combinedTotal, 0n, "accrual plus reversal nets to zero");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "month-end accruals reverse on their stored date and do not overlap the next period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payout Clerk", "admin");
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
      for (const date of ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-28", "2026-03-01"]) {
        await ensureOpenPeriod(org.orgId, org.periodId, date);
      }
      await pullConfig(
        org.orgId,
        actor,
        org.accounts.bank,
        org.accounts.adjustment,
        org.accounts.fxGainLoss,
        org.accounts.clearing,
      );
      const batchId = await postedBatch(
        org.orgId,
        actor,
        "po_month_end_transit",
        { bank: org.accounts.bank, fee: org.accounts.adjustment, clearing: org.accounts.clearing },
        "2026-01-30",
      );

      const january = await accruePayoutsInTransit(org.orgId, "2026-01-31", actor, null);
      assert.equal(january.accrued.length, 1);
      assert.equal(january.accrued[0]!.batchId, batchId);

      const february = await accruePayoutsInTransit(org.orgId, "2026-02-28", actor, null);
      assert.equal(february.reversed.length, 1);
      assert.equal(february.accrued.length, 1);
      const rows = await db.execute<{
        accrual_date: string;
        reversal_date: string;
        status: string;
        accrual_status: string;
        reversal_posting_date: string | null;
      }>(
        sql`
      select a.accrual_date::text, a.reversal_date::text, a.status,
             source.status as accrual_status, reversal.posting_date::text as reversal_posting_date
        from psp_payout_accruals a
        join journal_entries source on source.id = a.accrual_entry_id and source.org_id = a.org_id
        left join journal_entries reversal on reversal.id = a.reversal_entry_id and reversal.org_id = a.org_id
       where a.org_id = ${org.orgId} and a.batch_id = ${batchId}
       order by a.accrual_date
    `,
        "objects",
      );
      assert.deepEqual(
        rows.map((row) => [
          row.accrual_date,
          row.reversal_date,
          row.status,
          row.accrual_status,
          row.reversal_posting_date,
        ]),
        [
          ["2026-01-31", "2026-02-01", "reversed", "reversed", "2026-02-01"],
          ["2026-02-28", "2026-03-01", "accrued", "posted", null],
        ],
      );
      const balance = (
        await db.execute<{ amount: string }>(
          sql`
      select coalesce(sum(jl.amount), 0)::text as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.clearing}
         and je.origin = 'accrual' and je.posting_date <= '2026-02-28'
    `,
          "objects",
        )
      )[0]!;
      assert.equal(
        balance.amount,
        "97.1000",
        "only February's single payout reclass remains at month end",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reversing a settlement also reverses its outstanding payout accrual",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payout Clerk", "admin");
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
      await ensureOpenPeriod(org.orgId, org.periodId);
      await pullConfig(
        org.orgId,
        actor,
        org.accounts.bank,
        org.accounts.adjustment,
        org.accounts.fxGainLoss,
        org.accounts.clearing,
      );
      const batchId = await postedBatch(org.orgId, actor, "po_reverse_with_accrual", {
        bank: org.accounts.bank,
        fee: org.accounts.adjustment,
        clearing: org.accounts.clearing,
      });
      const accrued = await accruePayoutsInTransit(org.orgId, "2026-07-15", actor, null);
      assert.equal(accrued.accrued.length, 1);

      const reversed = await reverseSettlementBatch(
        org.orgId,
        batchId,
        actor,
        {
          reversalDate: "2026-07-16",
          reason: "Provider confirmed payout cancellation",
        },
        null,
      );
      const retry = await reverseSettlementBatch(
        org.orgId,
        batchId,
        actor,
        {
          reversalDate: "2026-07-16",
          reason: "Provider confirmed payout cancellation",
        },
        null,
      );
      assert.equal(retry.entryId, reversed.entryId);
      const row = (
        await db.execute<{
          status: string;
          accrual_status: string;
          reversal_entry_id: string | null;
        }>(
          sql`
      select a.status, source.status as accrual_status, a.reversal_entry_id
        from psp_payout_accruals a
        join journal_entries source on source.id = a.accrual_entry_id and source.org_id = a.org_id
       where a.org_id = ${org.orgId} and a.batch_id = ${batchId}
    `,
          "objects",
        )
      )[0]!;
      assert.equal(row.status, "reversed");
      assert.equal(row.accrual_status, "reversed");
      assert.ok(row.reversal_entry_id);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

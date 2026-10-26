import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runRevaluation } from "../close/fx-revaluation.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { writeOffInvoice } from "./invoice-write-off.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";

// Writing off a foreign-currency invoice: in its own currency, at the rate
// its remaining receivable is carried at, against real Postgres.
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Fixture {
  org: ScratchOrg;
  userId: string;
  badDebt: string;
}

async function withFxOrg(work: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypass(() => createScratchOrg());
  try {
    // A context-only bypass: each write-off runs in its own transaction, so a
    // refusal rolls back exactly what that write-off began.
    await withBypassContext(async () => {
      const userId = await createScratchUser(org.orgId, "Credit control", "admin");
      await db.execute(sql`
        insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
        -- The currency vocabulary is shared; an existing row is the same currency.
        on conflict (code) do nothing`);
      const badDebt = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${badDebt}, ${org.orgId}, '6950', 'Bad debt', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(sql`
        update orgs set settings = jsonb_set(jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency":true}'::jsonb),
                                             '{controlAccounts}', coalesce(settings->'controlAccounts', '{}'::jsonb) || jsonb_build_object('badDebtExpense', ${badDebt}::text, 'fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
         where id = ${org.orgId}`);
      await work({ org, userId, badDebt });
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}

async function postUsdInvoice(
  f: Fixture,
  amount: string,
  fxRate: string,
): Promise<{ id: string; lineId: string }> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${f.org.orgId}, 'customer_invoice', 'draft', ${`INV-${id.slice(0, 8)}`}, ${f.org.subsidiaryId}, ${f.org.customerId}, ${f.org.date}, 'USD', ${fxRate}, ${amount}, '0', ${amount}, ${f.userId})`);
  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${f.org.orgId}, ${id}, 1, ${f.org.accounts.revenue}, '1', ${amount}, ${amount}, '0')`);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${id} and org_id = ${f.org.orgId}`,
  );
  await postDocument(id, {
    control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank },
  });
  const lineId = (
    await db.execute<{ id: string }>(
      sql`
    select jl.id from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${f.org.orgId} and je.source_document_id = ${id} and jl.is_open_item`,
      "objects",
    )
  )[0]!.id;
  return { id, lineId };
}

/** The invoice's open item in both frames, after every live application. */
async function openFrames(f: Fixture, lineId: string): Promise<{ txn: string; base: string }> {
  return (
    await db.execute<{ txn: string; base: string }>(
      sql`
    select (abs(jl.txn_amount) - coalesce(sum(a.target_transaction_amount) filter (where a.unapplied_at is null), 0))::text as txn,
           (abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0))::text as base
      from journal_lines jl left join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id
     where jl.org_id = ${f.org.orgId} and jl.id = ${lineId} group by jl.id`,
      "objects",
    )
  )[0]!;
}

async function sumOn(f: Fixture, accountId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ total: string }>(
        sql`
    select coalesce(sum(amount), 0)::text as total from journal_lines where org_id = ${f.org.orgId} and account_id = ${accountId}`,
        "objects",
      )
    )[0]!.total,
  );
}

function writeOff(f: Fixture, invoiceId: string, amount: string, date = f.org.date) {
  return writeOffInvoice(
    f.org.orgId,
    f.userId,
    { invoiceId, amount, date, reason: "Customer ceased trading", idempotencyKey: randomUUID() },
    null,
  );
}

test(
  "a USD invoice paid in part, then written off, clears at its carrying rate in both currencies",
  { skip: !DB },
  () =>
    withFxOrg(async (f) => {
      const invoice = await postUsdInvoice(f, "100.00", "1.30");
      // 60 USD received at 1.35: the receipt realizes its own 3 CAD gain and leaves 40 USD carried at 52 CAD.
      const receipt = await createPaymentDocument({
        orgId: f.org.orgId,
        kind: "customer_payment",
        createdBy: f.userId,
        allowedSubsidiaryIds: null,
        partyId: f.org.customerId,
        bankAccountId: f.org.accounts.bank,
        subsidiaryId: f.org.subsidiaryId,
        documentDate: f.org.date,
        currency: "USD",
      });
      const allocations = [sameCurrencyAllocation(invoice.lineId, "60")];
      await updateDraftPayment(
        receipt.id,
        {
          allocations,
          explicitFx: {
            rate: "1.35",
            source: "Bank confirmation",
            reason: "Rate on the bank's credit advice",
            fromCurrency: "USD",
            toCurrency: "CAD",
            rateDate: f.org.date,
          },
        },
        f.userId,
        f.org.orgId,
        { allowedSubsidiaryIds: null },
      );
      await db.execute(
        sql`update documents set status = 'approved', updated_at = now() where id = ${receipt.id} and org_id = ${f.org.orgId}`,
      );
      await withOrgTransaction(f.org.orgId, () =>
        postPaymentWithApplications(receipt.id, allocations, f.userId, "ui", {
          deferEffects: true,
        }),
      );
      assert.deepEqual(await openFrames(f, invoice.lineId), { txn: "40.0000", base: "52.0000" });
      const gainBefore = await sumOn(f, f.org.accounts.fxGainLoss);

      const result = await writeOff(f, invoice.id, "40.00");
      assert.equal(result.currency, "USD");
      assert.deepEqual(
        await openFrames(f, invoice.lineId),
        { txn: "0.0000", base: "0.0000" },
        "the receivable clears in both currencies",
      );
      assert.equal(await sumOn(f, f.badDebt), 52, "the expense is the carrying amount written off");
      assert.equal(
        await sumOn(f, f.org.accounts.fxGainLoss),
        gainBefore,
        "a write-off at the carrying rate realizes no exchange difference",
      );
      const credit = (
        await db.execute<{
          currency: string;
          fx_rate: string;
          evidence: { rate: string; source: string };
        }>(
          sql`
      select currency, fx_rate::text as fx_rate, document_fx_rate_evidence as evidence from documents where org_id = ${f.org.orgId} and id = ${result.creditMemoId}`,
          "objects",
        )
      )[0]!;
      assert.equal(credit.currency, "USD");
      assert.equal(Number(credit.fx_rate), 1.3);
      assert.equal(credit.evidence.source, "Receivable carrying rate");
      const application = (
        await db.execute<{ fx: string | null }>(
          sql`
      select fx_gain_loss_entry_id as fx from applications where org_id = ${f.org.orgId} and to_line_id = ${invoice.lineId} and id = ${result.applicationIds[0]}`,
          "objects",
        )
      )[0]!;
      assert.equal(application.fx, null);
    }),
);

test("a carrying amount that is not a round rate still clears exactly", { skip: !DB }, () =>
  withFxOrg(async (f) => {
    const invoice = await postUsdInvoice(f, "333.33", "1.3333");
    const before = await openFrames(f, invoice.lineId);
    await writeOff(f, invoice.id, "100.01");
    const after = await openFrames(f, invoice.lineId);
    assert.equal(after.txn, "233.3200");
    const relieved = Number(before.base) - Number(after.base);
    assert.equal(
      await sumOn(f, f.badDebt),
      relieved,
      "the expense equals the carrying amount relieved",
    );
    await writeOff(f, invoice.id, "233.32");
    assert.deepEqual(await openFrames(f, invoice.lineId), { txn: "0.0000", base: "0.0000" });
    assert.equal(await sumOn(f, f.badDebt), Number(before.base));
  }),
);

test(
  "a revalued receivable is written off at its carrying amount; the unrealized revaluation stays and reverses on its own",
  { skip: !DB },
  () =>
    withFxOrg(async (f) => {
      const invoice = await postUsdInvoice(f, "100.00", "1.30");
      await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${f.org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${f.org.periodId}`);
      await db.execute(
        sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate) values (${f.org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.4000000000')`,
      );
      await db.execute(
        sql`insert into fx_rate_age_policies (org_id, rate_kind, max_age_days, effective_from) values (${f.org.orgId}, 'closing', 7, '2026-07-01')`,
      );
      const run = await runRevaluation(f.org.orgId, f.org.periodId, f.userId);
      assert.deepEqual(run.problems, []);
      assert.equal(run.posted.length, 1);
      assert.equal(
        run.posted[0]!.netDelta,
        "10.0000",
        "the receivable is restated by 10 CAD at 1.40",
      );

      await writeOff(f, invoice.id, "100.00", "2026-07-31");
      assert.deepEqual(await openFrames(f, invoice.lineId), { txn: "0.0000", base: "0.0000" });
      assert.equal(
        await sumOn(f, f.badDebt),
        130,
        "the write-off relieves the 130 CAD carrying amount, not the revalued 140",
      );
      const revaluation = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and origin = 'fx_revaluation' and status in ('posted', 'reversed')`,
          "objects",
        )
      )[0]!.n;
      assert.equal(
        revaluation,
        2,
        "the period-end adjustment and its next-period mirror stand untouched",
      );
    }),
);

test(
  "a closed receivables period refuses a foreign write-off and records nothing",
  { skip: !DB },
  () =>
    withFxOrg(async (f) => {
      const invoice = await postUsdInvoice(f, "100.00", "1.30");
      const bookId = await paymentBookId(f.org.orgId);
      await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
      values (${f.org.orgId}, ${f.org.periodId}, ${bookId}, ${f.org.subsidiaryId}, 'ar', 'closed', now(), ${f.userId})`);
      await assert.rejects(writeOff(f, invoice.id, "100.00"), /closed/i);
      assert.deepEqual(await openFrames(f, invoice.lineId), { txn: "100.0000", base: "130.0000" });
      const credits = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from documents where org_id = ${f.org.orgId} and kind = 'customer_credit'`,
          "objects",
        )
      )[0]!.n;
      assert.equal(credits, 0);
    }),
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
} from "@openbooks/engine/testing/fixtures";
import { ensureOpenReconciliation } from "./banking-rules.ts";
import {
  listOpenDocumentCandidates,
  recordPaymentAndMatch,
  SettlementMatchRefusal,
  type RecordPaymentMatchInput,
} from "./banking-match-candidates.ts";

// Partial, overpaid, written-off and foreign-currency settlement of a bank
// line through the native receipt, bill-payment, write-off and exchange-rate
// services against real Postgres. Only grants, accounts and rates are seeded.
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

interface Fixture {
  org: Org;
  actorId: string;
  reconId: string;
  lineId: string;
  documentId: string;
  openLineId: string;
}

async function postDocumentFor(
  org: Org,
  actorId: string,
  input: {
    kind: "customer_invoice" | "vendor_bill";
    number: string;
    amount: string;
    currency: string;
    fxRate: string;
  },
) {
  const id = randomUUID();
  const invoice = input.kind === "customer_invoice";
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, ${input.kind}, 'draft', ${input.number}, ${org.subsidiaryId},
              ${invoice ? org.customerId : org.vendorId}, ${org.date}, ${org.date}, ${input.currency}, ${input.fxRate},
              ${input.amount}, '0', ${input.amount}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${id}, 1, ${invoice ? org.accounts.revenue : org.accounts.adjustment}, '1', ${input.amount}, ${input.amount}, '0', '0')`);
    await db.execute(
      sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`,
    );
    await postDocument(id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
  });
  const openLineId = (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
    select jl.id from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${org.orgId} and je.source_document_id = ${id} and jl.is_open_item`,
        "objects",
      ),
    )
  )[0]!.id;
  return { documentId: id, openLineId };
}

async function fixture(options: {
  side?: "ar" | "ap";
  documentAmount: string;
  lineAmount: string;
  currency?: string;
  /** The document's currency, when it differs from the line's. */
  documentCurrency?: string;
  documentFxRate?: string;
  permissions?: readonly string[];
}): Promise<Fixture> {
  const side = options.side ?? "ar";
  const currency = options.currency ?? "CAD";
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Bank Reviewer", "bank_preparer"),
  );
  await withBypassContext(() =>
    grantScratchPermissions(
      org.orgId,
      actorId,
      options.permissions ?? [
        "banking.reconcile",
        "gl.post",
        ...(side === "ar" ? ["ar.create", "ar.pay"] : ["ap.pay"]),
      ],
    ),
  );
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
      -- The currency vocabulary is shared; an existing row is the same currency.
      on conflict (code) do nothing`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"banking":true,"multiCurrency":true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update accounts set reconcilable = true, currency_restriction = ${currency}, subsidiary_id = ${org.subsidiaryId}
       where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
  });
  const posted = await postDocumentFor(org, actorId, {
    kind: side === "ar" ? "customer_invoice" : "vendor_bill",
    number: side === "ar" ? "INV-7731" : "BILL-4410",
    amount: options.documentAmount,
    currency: options.documentCurrency ?? currency,
    fxRate: options.documentFxRate ?? "1",
  });
  const statementId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
      values (${statementId}, ${org.orgId}, ${org.accounts.bank}, 'settlement-fixture', ${org.date}, ${options.lineAmount}, 'settlement-fixture.raw')`);
    await db.execute(sql`
      insert into bank_statement_lines
        (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
      values (${lineId}, ${org.orgId}, ${statementId}, 1, ${org.date}, ${options.lineAmount}, ${currency},
              ${side === "ar" ? "DEPOSIT INV7731" : "PAYMENT BILL4410"}, 'unmatched', ${org.accounts.bank})`);
  });
  const reconId = await withBypassContext(() =>
    ensureOpenReconciliation(org.orgId, actorId, org.accounts.bank, null),
  );
  return {
    org,
    actorId,
    reconId,
    lineId,
    documentId: posted.documentId,
    openLineId: posted.openLineId,
  };
}

function record(f: Fixture, expectedOpen: string, extra: Partial<RecordPaymentMatchInput> = {}) {
  return withOrgContext(f.org.orgId, () =>
    recordPaymentAndMatch(
      f.org.orgId,
      f.actorId,
      {
        statementLineId: f.lineId,
        reconciliationId: f.reconId,
        openLineIds: [f.openLineId],
        expectedOpen: { [f.openLineId]: expectedOpen },
        ...extra,
      },
      null,
    ),
  );
}

function candidates(f: Fixture) {
  return withOrgContext(f.org.orgId, () =>
    listOpenDocumentCandidates(
      f.org.orgId,
      f.actorId,
      { statementLineId: f.lineId, reconciliationId: f.reconId },
      null,
    ),
  );
}

async function openOf(f: Fixture, side: "ar" | "ap", partyId: string) {
  const items = await withBypassContext(() => openItemsForParty(partyId, side, f.org.orgId));
  return items.find((item) => item.lineId === f.openLineId)?.transactionOpen ?? "0";
}

async function paymentLegs(orgId: string, paymentId: string) {
  return await withBypassContext(() =>
    db.execute<{ account_id: string; amount: string; is_open_item: boolean }>(
      sql`
    select l.account_id, l.amount::text as amount, l.is_open_item
      from journal_lines l join documents d on d.org_id = l.org_id and d.posted_entry_id = l.entry_id
     where d.org_id = ${orgId} and d.id = ${paymentId}`,
      "objects",
    ),
  );
}

async function lineStatus(orgId: string, lineId: string): Promise<string> {
  return (
    await withBypassContext(() =>
      db.execute<{ match_status: string }>(
        sql`
    select match_status from bank_statement_lines where org_id = ${orgId} and id = ${lineId}`,
        "objects",
      ),
    )
  )[0]!.match_status;
}

async function paymentCount(orgId: string): Promise<number> {
  return (
    await withBypassContext(() =>
      db.execute<{ n: number }>(
        sql`
    select count(*)::int as n from documents where org_id = ${orgId} and kind in ('customer_payment', 'vendor_payment')`,
        "objects",
      ),
    )
  )[0]!.n;
}

const sumOf = (legs: { amount: string }[]) =>
  legs.reduce((total, leg) => total + toUnits(leg.amount), 0n);

test(
  "a deposit smaller than the invoice is proposed as a part payment and leaves the rest open",
  { skip: !DB },
  async () => {
    const f = await fixture({ documentAmount: "1250.00", lineAmount: "1000.0000" });
    try {
      const proposed = await candidates(f);
      const partial = proposed.proposals.find((proposal) => proposal.settlement === "partial");
      assert.ok(partial, "the referenced invoice is proposed as a part payment");
      assert.deepEqual(partial.applied, { [f.openLineId]: "1000.0000" });
      assert.deepEqual(partial.reasons[0], { code: "partial_open_balance", remaining: "250.0000" });

      // Without an allocation the selection must settle exactly.
      await assert.rejects(
        record(f, "1250.0000"),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          /selected documents total 1250\.0000/.test(error.message),
      );

      const result = await record(f, "1250.0000", { applied: { [f.openLineId]: "1000.0000" } });
      assert.equal(result.onAccount, "0.0000");
      assert.equal(await openOf(f, "ar", f.org.customerId), "250.0000");
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
      const legs = await paymentLegs(f.org.orgId, result.paymentId);
      assert.equal(sumOf(legs), 0n);
      assert.equal(
        toUnits(legs.find((leg) => leg.account_id === f.org.accounts.bank)!.amount),
        toUnits("1000"),
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a deposit larger than the invoice settles it in full and keeps the excess as an unapplied customer credit",
  { skip: !DB },
  async () => {
    const f = await fixture({ documentAmount: "1250.00", lineAmount: "1300.0000" });
    try {
      const result = await record(f, "1250.0000", { applied: { [f.openLineId]: "1250.0000" } });
      assert.equal(result.onAccount, "50.0000");
      assert.equal(await openOf(f, "ar", f.org.customerId), "0");
      const credit = (
        await withBypassContext(() =>
          db.execute<{ txn: string; applied: string }>(
            sql`
      select abs(l.txn_amount)::text as txn,
             coalesce((select sum(a.source_transaction_amount) from applications a
                        where a.org_id = l.org_id and a.from_line_id = l.id and a.unapplied_at is null), 0)::text as applied
        from journal_lines l join documents d on d.org_id = l.org_id and d.posted_entry_id = l.entry_id
       where d.org_id = ${f.org.orgId} and d.id = ${result.paymentId} and l.is_open_item`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        toUnits(credit.txn) - toUnits(credit.applied),
        toUnits("50"),
        "50 stays open on the receipt as the customer's credit",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a short-paid invoice is written off through the governed write-off in the same unit",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "1250.00",
      lineAmount: "1240.0000",
      permissions: ["banking.reconcile", "ar.create", "ar.pay", "ar.post"],
    });
    try {
      // Without the write-off account the whole settlement refuses and records nothing.
      await assert.rejects(
        record(f, "1250.0000", {
          applied: { [f.openLineId]: "1240.0000" },
          writeOff: { reason: "Short-paid bank charge" },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal && /cannot be written off/.test(error.message),
      );
      assert.equal(await paymentCount(f.org.orgId), 0);
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "unmatched");

      const badDebt = await withBypassContext(() =>
        seedPostingAccount(f.org.orgId, "6950", "Bad debt", "expense", f.org.subsidiaryId),
      );
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,badDebtExpense}', to_jsonb(${badDebt}::text)) where id = ${f.org.orgId}`),
      );
      const result = await record(f, "1250.0000", {
        applied: { [f.openLineId]: "1240.0000" },
        writeOff: { reason: "Short-paid bank charge" },
      });
      assert.equal(result.writeOffTotal, "10.0000");
      assert.equal(result.writeOffDocuments.length, 1);
      assert.equal(
        await openOf(f, "ar", f.org.customerId),
        "0",
        "the invoice is settled by cash and the write-off",
      );
      const expense = (
        await withBypassContext(() =>
          db.execute<{ amount: string }>(
            sql`
      select coalesce(sum(amount), 0)::text as amount from journal_lines where org_id = ${f.org.orgId} and account_id = ${badDebt}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(toUnits(expense.amount), toUnits("10"));
      const audit = await withBypassContext(() =>
        db.execute<{ changes: { writeOff: { total: string; reason: string } } }>(
          sql`
      select changes from audit_log where org_id = ${f.org.orgId} and row_id = ${f.lineId} and changes->>'operation' = 'record_payment_match'`,
          "objects",
        ),
      );
      assert.deepEqual(
        [audit[0]!.changes.writeOff.total, audit[0]!.changes.writeOff.reason],
        ["10.0000", "Short-paid bank charge"],
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a customer write-off needs ar.post, and leftover cash refuses a write-off",
  { skip: !DB },
  async () => {
    const f = await fixture({ documentAmount: "1250.00", lineAmount: "1240.0000" });
    try {
      await assert.rejects(
        record(f, "1250.0000", {
          applied: { [f.openLineId]: "1240.0000" },
          writeOff: { reason: "Short-paid bank charge" },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          error.status === 403 &&
          /ar\.post/.test(error.message),
      );
      assert.equal(await paymentCount(f.org.orgId), 0);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
    const missingCreate = await fixture({
      documentAmount: "1250.00",
      lineAmount: "1240.0000",
      permissions: ["banking.reconcile", "ar.pay", "ar.post"],
    });
    try {
      await assert.rejects(
        record(missingCreate, "1250.0000", {
          applied: { [missingCreate.openLineId]: "1240.0000" },
          writeOff: { reason: "Short-paid bank charge" },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          error.status === 403 &&
          /ar\.create/.test(error.message),
      );
      assert.equal(await paymentCount(missingCreate.org.orgId), 0);
    } finally {
      await withBypassContext(() => dropScratchOrg(missingCreate.org.orgId));
    }
    const g = await fixture({
      documentAmount: "1250.00",
      lineAmount: "1240.0000",
      permissions: ["banking.reconcile", "ar.create", "ar.pay", "ar.post"],
    });
    try {
      await assert.rejects(
        record(g, "1250.0000", {
          applied: { [g.openLineId]: "1200.0000" },
          writeOff: { reason: "Short-paid bank charge" },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal && /stay unapplied/.test(error.message),
      );
      assert.equal(await paymentCount(g.org.orgId), 0);
    } finally {
      await withBypassContext(() => dropScratchOrg(g.org.orgId));
    }
  },
);

test(
  "a short bill payment takes the difference as a payment discount to the chosen account",
  { skip: !DB },
  async () => {
    const f = await fixture({ side: "ap", documentAmount: "500.00", lineAmount: "-490.0000" });
    try {
      await assert.rejects(
        record(f, "500.0000", {
          applied: { [f.openLineId]: "490.0000" },
          writeOff: { reason: "Early payment discount" },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal && /Choose the account/.test(error.message),
      );
      const discount = await withBypassContext(() =>
        seedPostingAccount(
          f.org.orgId,
          "4950",
          "Purchase discounts",
          "income_other",
          f.org.subsidiaryId,
        ),
      );
      const result = await record(f, "500.0000", {
        applied: { [f.openLineId]: "490.0000" },
        writeOff: { reason: "Early payment discount", discountAccountId: discount },
      });
      assert.equal(result.kind, "vendor_payment");
      assert.equal(result.writeOffTotal, "10.0000");
      assert.equal(await openOf(f, "ap", f.org.vendorId), "0");
      const legs = await paymentLegs(f.org.orgId, result.paymentId);
      assert.equal(sumOf(legs), 0n);
      assert.equal(
        toUnits(legs.find((leg) => leg.account_id === f.org.accounts.bank)!.amount),
        toUnits("-490"),
      );
      assert.equal(
        toUnits(legs.find((leg) => leg.account_id === discount)!.amount),
        toUnits("-10"),
      );
      assert.equal(
        toUnits(legs.find((leg) => leg.is_open_item)!.amount),
        toUnits("500"),
        "the payable is relieved in full",
      );
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a bill overpayment keeps the excess as a vendor prepayment on the payable",
  { skip: !DB },
  async () => {
    const f = await fixture({ side: "ap", documentAmount: "500.00", lineAmount: "-520.0000" });
    try {
      const result = await record(f, "500.0000", { applied: { [f.openLineId]: "500.0000" } });
      assert.equal(result.onAccount, "20.0000");
      const legs = await paymentLegs(f.org.orgId, result.paymentId);
      const payable = legs.find((leg) => leg.is_open_item)!;
      assert.equal(
        toUnits(payable.amount),
        toUnits("520"),
        "the payable is debited by everything paid",
      );
      assert.equal(await openOf(f, "ap", f.org.vendorId), "0");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a foreign-currency deposit is measured at the evidenced rate and realizes the exchange difference",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "100.00",
      lineAmount: "100.0000",
      currency: "USD",
      documentFxRate: "1.30",
    });
    try {
      // No evidenced rate: the line refuses unless the operator states one.
      await assert.rejects(
        record(f, "100.0000"),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal && /exchange rate/i.test(error.message),
      );
      assert.equal(await paymentCount(f.org.orgId), 0);

      await withBypassContext(() =>
        db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${randomUUID()}, ${f.org.orgId}, 'USD', 'CAD', ${f.org.date}, 'spot', '1.3500000000', 'test')`),
      );
      const proposed = await candidates(f);
      assert.equal(proposed.exchangeRates[f.org.subsidiaryId]?.functionalCurrency, "CAD");
      assert.equal(proposed.exchangeRates[f.org.subsidiaryId]?.rate, "1.3500000000");

      const result = await record(f, "100.0000");
      const legs = await paymentLegs(f.org.orgId, result.paymentId);
      assert.equal(
        toUnits(legs.find((leg) => leg.account_id === f.org.accounts.bank)!.amount),
        toUnits("135"),
        "the bank is measured at 1.35",
      );
      const gain = (
        await withBypassContext(() =>
          db.execute<{ amount: string }>(
            sql`
      select coalesce(sum(amount), 0)::text as amount from journal_lines where org_id = ${f.org.orgId} and account_id = ${f.org.accounts.fxGainLoss}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(toUnits(gain.amount), toUnits("-5"), "the 5 CAD difference is a realized gain");
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "an operator-entered rate measures a foreign line with its source and reason as evidence",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "100.00",
      lineAmount: "60.0000",
      currency: "USD",
      documentFxRate: "1.30",
    });
    try {
      const result = await record(f, "100.0000", {
        applied: { [f.openLineId]: "60.0000" },
        exchangeRate: {
          rate: "1.25",
          source: "Bank advice",
          reason: "Rate on the bank's credit advice",
        },
      });
      const legs = await paymentLegs(f.org.orgId, result.paymentId);
      assert.equal(
        toUnits(legs.find((leg) => leg.account_id === f.org.accounts.bank)!.amount),
        toUnits("75"),
      );
      const evidence = (
        await withBypassContext(() =>
          db.execute<{ fx_rate: string; evidence: { rate: string; source: string } | null }>(
            sql`
      select fx_rate::text as fx_rate, document_fx_rate_evidence as evidence from documents where org_id = ${f.org.orgId} and id = ${result.paymentId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(evidence.evidence?.rate, "1.25");
      assert.equal(evidence.evidence?.source, "Bank advice");
      const loss = (
        await withBypassContext(() =>
          db.execute<{ amount: string }>(
            sql`
      select coalesce(sum(amount), 0)::text as amount from journal_lines where org_id = ${f.org.orgId} and account_id = ${f.org.accounts.fxGainLoss}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        toUnits(loss.amount),
        toUnits("3"),
        "60 USD carried at 78 settles for 75: a 3 CAD loss",
      );
      assert.equal(await openOf(f, "ar", f.org.customerId), "40.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "two reviewers settling the same line in part concurrently produce one payment",
  { skip: !DB },
  async () => {
    const f = await fixture({ documentAmount: "1250.00", lineAmount: "1000.0000" });
    try {
      const attempt = () => record(f, "1250.0000", { applied: { [f.openLineId]: "1000.0000" } });
      const outcomes = await Promise.allSettled([attempt(), attempt()]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(await paymentCount(f.org.orgId), 1);
      assert.equal(await openOf(f, "ar", f.org.customerId), "250.0000", "the invoice is paid once");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a CAD deposit settles a USD invoice at the recorded settlement rate and realizes the difference",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "100.00",
      lineAmount: "135.0000",
      documentCurrency: "USD",
      documentFxRate: "1.30",
    });
    try {
      const rateId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${rateId}, ${f.org.orgId}, 'CAD', 'USD', ${f.org.date}, 'spot', '0.7407407407', 'Bank of Canada')`),
      );
      const proposed = await candidates(f);
      const doc = proposed.documents.find((entry) => entry.openLineId === f.openLineId)!;
      assert.equal(doc.currency, "USD");
      assert.equal(doc.transactionOpen, "100.0000");
      assert.equal(doc.lineEquivalent, "135.0000");
      assert.equal(doc.settlementRate?.fxRateId, rateId);
      const exact = proposed.proposals.find((proposal) =>
        proposal.openLineIds.includes(f.openLineId),
      );
      assert.equal(
        exact?.settlement,
        "exact",
        "135 CAD settles the 100 USD invoice exactly at the recorded rate",
      );

      const result = await record(f, "100.0000");
      assert.equal(await openOf(f, "ar", f.org.customerId), "0");
      const application = (
        await withBypassContext(() =>
          db.execute<{
            source: string;
            target: string;
            rate_source: string;
            fx_rate_id: string | null;
            fx_entry: string | null;
          }>(
            sql`
      select source_transaction_amount::text as source, target_transaction_amount::text as target, settlement_rate_source as rate_source,
             settlement_fx_rate_id as fx_rate_id, fx_gain_loss_entry_id as fx_entry
        from applications where org_id = ${f.org.orgId} and to_line_id = ${f.openLineId} and unapplied_at is null`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(
        [application.source, application.target, application.rate_source, application.fx_rate_id],
        ["135.0000", "100.0000", "provider", rateId],
      );
      assert.ok(application.fx_entry, "the realized difference posts natively");
      const gain = (
        await withBypassContext(() =>
          db.execute<{ amount: string }>(
            sql`
      select coalesce(sum(amount), 0)::text as amount from journal_lines where org_id = ${f.org.orgId} and account_id = ${f.org.accounts.fxGainLoss}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        toUnits(gain.amount),
        toUnits("-5"),
        "135 CAD received for an invoice carried at 130 CAD is a 5 CAD gain",
      );
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
      assert.equal(result.kind, "customer_payment");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a document in another currency with no recorded rate settles at a rate the operator states with its source and reason",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "100.00",
      lineAmount: "60.0000",
      documentCurrency: "USD",
      documentFxRate: "1.30",
    });
    try {
      const proposed = await candidates(f);
      const doc = proposed.documents.find((entry) => entry.openLineId === f.openLineId)!;
      assert.equal(doc.lineEquivalent, null, "it is listed for the operator to state a rate");
      assert.equal(doc.settlementRate, null);
      await assert.rejects(
        record(f, "100.0000", { applied: { [f.openLineId]: "60.0000" } }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          /no CAD→USD settlement rate is recorded/.test(error.message),
      );
      await assert.rejects(
        record(f, "100.0000", {
          applied: { [f.openLineId]: "60.0000" },
          settlementRates: {
            [f.openLineId]: { rate: "0.75", source: "Bank advice", reason: "short" },
          },
        }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          /reason of at least eight characters/.test(error.message),
      );
      assert.equal(await paymentCount(f.org.orgId), 0);
      await record(f, "100.0000", {
        applied: { [f.openLineId]: "60.0000" },
        settlementRates: {
          [f.openLineId]: {
            rate: "0.75",
            source: "Bank advice",
            reason: "Rate on the bank's credit advice",
          },
        },
      });
      assert.equal(
        await openOf(f, "ar", f.org.customerId),
        "55.0000",
        "60 CAD at 0.75 settles 45 of the 100 USD",
      );
      const application = (
        await withBypassContext(() =>
          db.execute<{ rate_source: string; reference: string }>(
            sql`
      select settlement_rate_source as rate_source, settlement_rate_reference as reference
        from applications where org_id = ${f.org.orgId} and to_line_id = ${f.openLineId} and unapplied_at is null`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(application.rate_source, "manual");
      assert.match(application.reference, /Bank advice/);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a party's unapplied credit is suggested beside the documents it could settle",
  { skip: !DB },
  async () => {
    const f = await fixture({ documentAmount: "1250.00", lineAmount: "1300.0000" });
    try {
      await record(f, "1250.0000", { applied: { [f.openLineId]: "1250.0000" } });
      // A second deposit for the same customer: the 50 kept on account is suggested.
      const statementId = randomUUID();
      const lineId = randomUUID();
      await postDocumentFor(f.org, f.actorId, {
        kind: "customer_invoice",
        number: "INV-7740",
        amount: "200.00",
        currency: "CAD",
        fxRate: "1",
      });
      await withBypassContext(async () => {
        await db.execute(sql`
        insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
        values (${statementId}, ${f.org.orgId}, ${f.org.accounts.bank}, 'settlement-fixture', ${f.org.date}, '150.0000', 'settlement-fixture-2.raw')`);
        await db.execute(sql`
        insert into bank_statement_lines (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
        values (${lineId}, ${f.org.orgId}, ${statementId}, 1, ${f.org.date}, '150.0000', 'CAD', 'DEPOSIT INV7740', 'unmatched', ${f.org.accounts.bank})`);
      });
      const proposed = await withOrgContext(f.org.orgId, () =>
        listOpenDocumentCandidates(
          f.org.orgId,
          f.actorId,
          { statementLineId: lineId, reconciliationId: f.reconId },
          null,
        ),
      );
      assert.deepEqual(
        proposed.unappliedCredits[f.org.customerId]?.map((credit) => credit.open),
        ["50.0000"],
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a CAD deposit short-pays a USD invoice and the remainder is written off at the receivable's carrying rate",
  { skip: !DB },
  async () => {
    const f = await fixture({
      documentAmount: "100.00",
      lineAmount: "108.0000",
      documentCurrency: "USD",
      documentFxRate: "1.30",
      permissions: ["banking.reconcile", "ar.create", "ar.pay", "ar.post"],
    });
    try {
      await withBypassContext(() =>
        db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${randomUUID()}, ${f.org.orgId}, 'CAD', 'USD', ${f.org.date}, 'spot', '0.7407407407', 'Bank of Canada')`),
      );
      const badDebt = await withBypassContext(() =>
        seedPostingAccount(f.org.orgId, "6950", "Bad debt", "expense", f.org.subsidiaryId),
      );
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,badDebtExpense}', to_jsonb(${badDebt}::text)) where id = ${f.org.orgId}`),
      );
      const result = await record(f, "100.0000", {
        applied: { [f.openLineId]: "108.0000" },
        writeOff: { reason: "Bank charges short-paid" },
      });
      assert.equal(result.writeOffDocuments.length, 1);
      assert.equal(
        await openOf(f, "ar", f.org.customerId),
        "0",
        "80 USD by cash and 20 USD by write-off clear the invoice",
      );
      const totals = async (accountId: string) =>
        toUnits(
          (
            await withBypassContext(() =>
              db.execute<{ amount: string }>(
                sql`
      select coalesce(sum(amount), 0)::text as amount from journal_lines where org_id = ${f.org.orgId} and account_id = ${accountId}`,
                "objects",
              ),
            )
          )[0]!.amount,
        );
      assert.equal(
        await totals(badDebt),
        toUnits("26"),
        "20 USD written off at its 1.30 carrying rate",
      );
      assert.equal(
        await totals(f.org.accounts.fxGainLoss),
        toUnits("-4"),
        "108 CAD received for 80 USD carried at 104 CAD realizes 4",
      );
      const residual = (
        await withBypassContext(() =>
          db.execute<{ base: string }>(
            sql`
      select (abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0))::text as base
        from journal_lines jl left join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id
       where jl.org_id = ${f.org.orgId} and jl.id = ${f.openLineId} group by jl.id`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(toUnits(residual.base), 0n, "no carrying amount is left on the receivable");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

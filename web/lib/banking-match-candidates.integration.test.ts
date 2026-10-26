import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import { paymentBookId } from "@openbooks/engine/payments/payment-accounts";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "@openbooks/engine/testing/fixtures";
import { ensureOpenReconciliation } from "./banking-rules.ts";
import {
  listOpenDocumentCandidates,
  recordPaymentAndMatch,
  SettlementMatchRefusal,
} from "./banking-match-candidates.ts";

// Record payment and match: the native receipt and bill-payment services
// against real Postgres. Only the actor's grants are seeded; the payment
// kernel, the matcher and the scope rules run unmodified.
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

interface Fixture {
  org: Org;
  actorId: string;
  reconId: string;
  lineId: string;
  invoiceId: string;
  openLineId: string;
}

async function postInvoice(
  org: Org,
  actorId: string,
  documentNumber: string,
  amount: string,
): Promise<{ invoiceId: string; openLineId: string }> {
  const invoiceId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${documentNumber}, ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1', ${amount}, '0', ${amount}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${amount}, ${amount}, '0')`);
    await db.execute(
      sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`,
    );
    await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
  });
  const openLineId = (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
    select jl.id from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${org.orgId} and je.source_document_id = ${invoiceId} and jl.is_open_item
  `,
        "objects",
      ),
    )
  )[0]!.id;
  return { invoiceId, openLineId };
}

async function fixture(
  permissions: readonly string[] = ["banking.reconcile", "ar.pay"],
  lineAmount = "1250.0000",
): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Bank Reviewer", "bank_preparer"),
  );
  await withBypassContext(() => grantScratchPermissions(org.orgId, actorId, permissions));
  await withBypassContext(async () =>
    db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD', subsidiary_id = ${org.subsidiaryId}
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `),
  );
  const { invoiceId, openLineId } = await postInvoice(org, actorId, "INV-7731", "1250.00");
  const statementId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
      values (${statementId}, ${org.orgId}, ${org.accounts.bank}, 'settlement-fixture', ${org.date}, ${lineAmount}, 'settlement-fixture.raw')
    `);
    await db.execute(sql`
      insert into bank_statement_lines
        (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
      values (${lineId}, ${org.orgId}, ${statementId}, 1, ${org.date}, ${lineAmount}, 'CAD', 'DEPOSIT INV7731', 'unmatched', ${org.accounts.bank})
    `);
  });
  const reconId = await withBypassContext(() =>
    ensureOpenReconciliation(org.orgId, actorId, org.accounts.bank, null),
  );
  return { org, actorId, reconId, lineId, invoiceId, openLineId };
}

function record(
  f: Fixture,
  overrides: { expectedOpen?: Record<string, string>; scope?: ReadonlySet<string> | null } = {},
) {
  return withOrgContext(f.org.orgId, () =>
    recordPaymentAndMatch(
      f.org.orgId,
      f.actorId,
      {
        statementLineId: f.lineId,
        reconciliationId: f.reconId,
        openLineIds: [f.openLineId],
        expectedOpen: overrides.expectedOpen ?? { [f.openLineId]: "1250.0000" },
      },
      overrides.scope === undefined ? null : overrides.scope,
    ),
  );
}

async function receiptCount(orgId: string): Promise<number> {
  return (
    await withBypassContext(() =>
      db.execute<{ n: number }>(
        sql`
    select count(*)::int as n from documents where org_id = ${orgId} and kind = 'customer_payment'
  `,
        "objects",
      ),
    )
  )[0]!.n;
}

async function lineStatus(orgId: string, lineId: string): Promise<string> {
  return (
    await withBypassContext(() =>
      db.execute<{ match_status: string }>(
        sql`
    select match_status from bank_statement_lines where org_id = ${orgId} and id = ${lineId}
  `,
        "objects",
      ),
    )
  )[0]!.match_status;
}

test(
  "record payment and match posts a balanced receipt, settles the invoice and matches the line",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const candidates = await withOrgContext(f.org.orgId, () =>
        listOpenDocumentCandidates(
          f.org.orgId,
          f.actorId,
          { statementLineId: f.lineId, reconciliationId: f.reconId },
          null,
        ),
      );
      assert.equal(candidates.side, "ar", "money in proposes customer invoices");
      assert.deepEqual(candidates.proposals[0]?.openLineIds, [f.openLineId]);
      assert.deepEqual(
        candidates.proposals[0]!.reasons.map((reason) => reason.code).slice(0, 2),
        ["exact_open_balance", "shared_reference"],
        "the invoice number on the deposit is a stated reason",
      );

      const result = await record(f);
      assert.equal(result.kind, "customer_payment");

      const payment = (
        await withBypassContext(() =>
          db.execute<{
            status: string;
            posted_entry_id: string;
            document_date: string;
            total: string;
          }>(
            sql`
      select status, posted_entry_id, document_date::text as document_date, total::text as total
        from documents where org_id = ${f.org.orgId} and id = ${result.paymentId}
    `,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(payment.status, "posted");
      assert.equal(payment.document_date, f.org.date, "the receipt is dated on the statement date");
      assert.equal(toUnits(payment.total), toUnits("1250"));

      const lines = await withBypassContext(() =>
        db.execute<{ id: string; account_id: string; amount: string }>(
          sql`
      select id, account_id, amount::text as amount from journal_lines
       where org_id = ${f.org.orgId} and entry_id = ${payment.posted_entry_id}
    `,
          "objects",
        ),
      );
      assert.equal(
        lines.reduce((total, line) => total + toUnits(line.amount), 0n),
        0n,
        "the receipt entry balances",
      );
      const bankLine = lines.find((line) => line.account_id === f.org.accounts.bank);
      assert.ok(
        bankLine && toUnits(bankLine.amount) === toUnits("1250"),
        "the bank leg debits the line's account",
      );

      const open = await withBypassContext(() =>
        openItemsForParty(f.org.customerId, "ar", f.org.orgId),
      );
      assert.ok(
        !open.some((item) => item.lineId === f.openLineId),
        "the invoice is no longer open",
      );

      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
      const match = await withBypassContext(() =>
        db.execute<{ journal_line_id: string; matched_by: string }>(
          sql`
      select journal_line_id, matched_by from reconciliation_matches
       where org_id = ${f.org.orgId} and statement_line_id = ${f.lineId}
    `,
          "objects",
        ),
      );
      assert.deepEqual(match, [{ journal_line_id: bankLine.id, matched_by: "manual" }]);

      const audit = await withBypassContext(() =>
        db.execute<{ changes: { paymentDocumentId: string } }>(
          sql`
      select changes from audit_log
       where org_id = ${f.org.orgId} and table_name = 'bank_statement_lines' and row_id = ${f.lineId}
         and changes->>'operation' = 'record_payment_match'
    `,
          "objects",
        ),
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.changes.paymentDocumentId, result.paymentId);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "two reviewers recording the same line concurrently produce one payment",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.allSettled([record(f), record(f)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const refused = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      assert.ok(refused, "the second attempt is refused");
      assert.match(String((refused.reason as Error).message), /already matched/);
      assert.equal(await receiptCount(f.org.orgId), 1, "the loser creates no receipt");
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a closed receivables period refuses and leaves no payment and no match",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const bookId = await withBypassContext(() => paymentBookId(f.org.orgId));
      await withBypassContext(async () =>
        db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
      values (${f.org.orgId}, ${f.org.periodId}, ${bookId}, ${f.org.subsidiaryId}, 'ar', 'closed', now(), ${f.actorId})
    `),
      );
      await assert.rejects(record(f), /closed/i);
      assert.equal(
        await receiptCount(f.org.orgId),
        0,
        "the refused receipt rolls back with the match",
      );
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "unmatched");
      const open = await withBypassContext(() =>
        openItemsForParty(f.org.customerId, "ar", f.org.orgId),
      );
      assert.ok(
        open.some((item) => item.lineId === f.openLineId),
        "the invoice stays open",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a changed open balance, a missing payment permission and an out-of-scope caller all refuse without writing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        record(f, { expectedOpen: { [f.openLineId]: "1200.0000" } }),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          error.status === 409 &&
          /open balance is now 1250\.0000/.test(error.message),
      );
      await assert.rejects(record(f, { scope: new Set([randomUUID()]) }), ScopeNotFoundError);
      await assert.rejects(
        withOrgContext(f.org.orgId, () =>
          listOpenDocumentCandidates(
            f.org.orgId,
            f.actorId,
            { statementLineId: f.lineId, reconciliationId: f.reconId },
            new Set([randomUUID()]),
          ),
        ),
        ScopeNotFoundError,
      );
      assert.equal(await receiptCount(f.org.orgId), 0);
      assert.equal(await lineStatus(f.org.orgId, f.lineId), "unmatched");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }

    const reconcileOnly = await fixture(["banking.reconcile"]);
    try {
      await assert.rejects(
        record(reconcileOnly),
        (error: unknown) =>
          error instanceof SettlementMatchRefusal &&
          error.status === 403 &&
          /ar\.pay/.test(error.message),
      );
      await assert.rejects(
        withOrgContext(reconcileOnly.org.orgId, () =>
          listOpenDocumentCandidates(
            reconcileOnly.org.orgId,
            reconcileOnly.actorId,
            { statementLineId: reconcileOnly.lineId, reconciliationId: reconcileOnly.reconId },
            null,
          ),
        ),
        (error: unknown) => error instanceof SettlementMatchRefusal && error.status === 403,
        "open invoices are not disclosed without the receipt permission",
      );
      assert.equal(await receiptCount(reconcileOnly.org.orgId), 0);
    } finally {
      await withBypassContext(() => dropScratchOrg(reconcileOnly.org.orgId));
    }
  },
);

test("several invoices of one customer combine to settle one deposit", { skip: !DB }, async () => {
  const f = await fixture(["banking.reconcile", "ar.pay"], "1500.0000");
  try {
    const second = await postInvoice(f.org, f.actorId, "INV-7732", "250.00");
    const candidates = await withOrgContext(f.org.orgId, () =>
      listOpenDocumentCandidates(
        f.org.orgId,
        f.actorId,
        { statementLineId: f.lineId, reconciliationId: f.reconId },
        null,
      ),
    );
    const combined = candidates.proposals.find((proposal) => proposal.openLineIds.length === 2);
    assert.ok(combined, "the two invoices are proposed together");
    assert.deepEqual([...combined.openLineIds].sort(), [f.openLineId, second.openLineId].sort());

    await withOrgContext(f.org.orgId, () =>
      recordPaymentAndMatch(
        f.org.orgId,
        f.actorId,
        {
          statementLineId: f.lineId,
          reconciliationId: f.reconId,
          openLineIds: combined.openLineIds,
          expectedOpen: { [f.openLineId]: "1250.0000", [second.openLineId]: "250.0000" },
        },
        null,
      ),
    );
    const open = await withBypassContext(() =>
      openItemsForParty(f.org.customerId, "ar", f.org.orgId),
    );
    assert.equal(
      open.filter((item) => item.lineId === f.openLineId || item.lineId === second.openLineId)
        .length,
      0,
    );
    assert.equal(await lineStatus(f.org.orgId, f.lineId), "matched");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

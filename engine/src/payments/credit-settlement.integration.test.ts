import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  applyStandaloneCredits,
  creditSettlementState,
  unapplyCreditSettlement,
} from "./credit-settlement.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-Postgres: applying a posted credit memo to a posted invoice when NO cash
 * moves. Before this path existed, `postPayment` refused any payment carrying
 * zero cash allocations ("select at least one open item to apply"), so a credit
 * that fully covered an invoice could not be applied at all — the balance stayed
 * open on both documents forever.
 *
 * The defining property asserted here is that the settlement writes NO journal
 * entry: the credit and the invoice already sit on the same AR control account,
 * so netting them moves no money and has nothing to post.
 */

async function postDoc(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  kind: "customer_invoice" | "customer_credit",
  documentNumber: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, ${kind}, 'draft', ${documentNumber},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              ${amount}, '0', ${amount}, ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', ${amount}, ${amount}, '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${id} and org_id = ${org.orgId}`);
  });
  await withBypass(() =>
    postDocument(id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  return id;
}

/** The posted open-item control line a settlement endpoint names. */
async function openLineId(orgId: string, documentId: string): Promise<string> {
  const row = await withBypass(async () =>
    (await db.execute<{ id: string }>(sql`
      select jl.id
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.source_document_id = ${documentId}
         and jl.is_open_item
       limit 1`)).rows[0],
  );
  assert.ok(row, `document ${documentId} has no open-item line`);
  return row.id;
}

async function openBalance(orgId: string, lineId: string): Promise<string> {
  const row = await withBypass(async () =>
    (await db.execute<{ open: string }>(sql`
      select (abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0))::text as open
        from journal_lines jl
        left join applications a on a.to_line_id = jl.id and a.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.id = ${lineId}
       group by jl.id`)).rows[0],
  );
  return row!.open;
}

async function sourceOpenBalance(orgId: string, lineId: string): Promise<string> {
  const row = await withBypass(async () =>
    (await db.execute<{ open: string }>(sql`
      select (abs(jl.amount) - coalesce(sum(a.source_amount) filter (where a.unapplied_at is null), 0))::text as open
        from journal_lines jl
        left join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.id = ${lineId}
       group by jl.id`)).rows[0],
  );
  return row!.open;
}

async function entryCount(orgId: string): Promise<number> {
  const row = await withBypass(async () =>
    (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from journal_entries where org_id = ${orgId}`)).rows[0],
  );
  return Number(row!.n);
}

test("a full credit settles an invoice with no cash and posts no journal entry", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Credit settler", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-1", "210");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-1", "210");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);
    assert.equal(await openBalance(org.orgId, invoiceLine), "210.0000");

    const entriesBefore = await entryCount(org.orgId);
    const result = await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId,
        side: "ar",
        appliedOn: org.date,
        credits: [
          { fromLineId: creditLine, toLineId: invoiceLine, amount: "210", sourceDocumentId: creditId },
        ],
      }),
    );

    assert.equal(result.applicationIds.length, 1);
    assert.equal(result.amount, "210.0000");
    // The whole point: settling a credit against an invoice moves no money.
    assert.equal(await entryCount(org.orgId), entriesBefore);
    assert.equal(await openBalance(org.orgId, invoiceLine), "0.0000");
    assert.equal(await sourceOpenBalance(org.orgId, creditLine), "0.0000");

    const audit = await withBypass(async () =>
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from audit_log
         where org_id = ${org.orgId} and table_name = 'applications'
           and row_id = ${result.applicationIds[0]!} and action = 'insert'`)).rows[0],
    );
    assert.equal(Number(audit!.n), 1);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a partial credit leaves the remainder open on both sides", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Partial settler", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-2", "500");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-2", "200");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);

    await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId,
        side: "ar",
        appliedOn: org.date,
        credits: [
          { fromLineId: creditLine, toLineId: invoiceLine, amount: "120", sourceDocumentId: creditId },
        ],
      }),
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "380.0000");
    assert.equal(await sourceOpenBalance(org.orgId, creditLine), "80.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("applying more than the credit's open balance is refused", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Over applier", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-3", "500");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-3", "200");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);

    await assert.rejects(
      () =>
        withBypass(() =>
          applyStandaloneCredits(org.orgId, userId, {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            credits: [
              { fromLineId: creditLine, toLineId: invoiceLine, amount: "201", sourceDocumentId: creditId },
            ],
          }),
        ),
      /exceed/i,
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "500.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a settlement with no credits is refused rather than reporting success", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Empty settler", "admin"));
    await assert.rejects(
      () =>
        withBypass(() =>
          applyStandaloneCredits(org.orgId, userId, {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            credits: [],
          }),
        ),
      /at least one credit/i,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a settlement dated into a closed AR period is refused", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Closed period settler", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-4", "90");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-4", "90");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);
    const bookId = await withBypass(() => paymentBookId(org.orgId));
    await withBypass(() =>
      db.execute(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
        values (${org.orgId}, ${org.periodId}, ${bookId}, ${org.subsidiaryId}, 'ar', 'closed', now(), ${userId})`),
    );

    await assert.rejects(
      () =>
        withBypass(() =>
          applyStandaloneCredits(org.orgId, userId, {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            credits: [
              { fromLineId: creditLine, toLineId: invoiceLine, amount: "90", sourceDocumentId: creditId },
            ],
          }),
        ),
      /AR is closed for this period/i,
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "90.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("releasing a credit settlement reopens both balances exactly once", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Releaser", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-5", "310");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-5", "310");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);

    const applied = await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId,
        side: "ar",
        appliedOn: org.date,
        credits: [
          { fromLineId: creditLine, toLineId: invoiceLine, amount: "310", sourceDocumentId: creditId },
        ],
      }),
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "0.0000");

    const released = await withBypass(() =>
      unapplyCreditSettlement(org.orgId, userId, applied.applicationIds[0]!),
    );
    assert.equal(released.amount, "310.0000");
    assert.equal(await openBalance(org.orgId, invoiceLine), "310.0000");
    assert.equal(await sourceOpenBalance(org.orgId, creditLine), "310.0000");

    // Releasing twice must refuse, not silently report a second release.
    await assert.rejects(
      () => withBypass(() => unapplyCreditSettlement(org.orgId, userId, applied.applicationIds[0]!)),
      /not live/i,
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "310.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the released credit can be applied again", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Reapplier", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-6", "75");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-6", "75");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);
    const credits = [
      { fromLineId: creditLine, toLineId: invoiceLine, amount: "75", sourceDocumentId: creditId },
    ];

    const first = await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId, side: "ar", appliedOn: org.date, credits,
      }),
    );
    await withBypass(() => unapplyCreditSettlement(org.orgId, userId, first.applicationIds[0]!));
    await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId, side: "ar", appliedOn: org.date, credits,
      }),
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "0.0000");
    assert.equal(await sourceOpenBalance(org.orgId, creditLine), "0.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a credit the wrong party owns cannot settle this party's invoice", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Cross party", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-7", "60");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-7", "60");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);
    const otherParty = randomUUID();
    await withBypass(() =>
      db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${otherParty}, ${org.orgId}, 'customer', 'Other Customer', true, '{}'::jsonb)`),
    );

    await assert.rejects(
      () =>
        withBypass(() =>
          applyStandaloneCredits(org.orgId, userId, {
            partyId: otherParty,
            side: "ar",
            appliedOn: org.date,
            credits: [
              { fromLineId: creditLine, toLineId: invoiceLine, amount: "60", sourceDocumentId: creditId },
            ],
          }),
        ),
      /party/i,
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "60.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a credit naming the wrong source document is refused", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Wrong source", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STANDALONE-8", "45");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STANDALONE-8", "45");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);

    await assert.rejects(
      () =>
        withBypass(() =>
          applyStandaloneCredits(org.orgId, userId, {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            credits: [
              // Names the invoice as the credit's own source document.
              { fromLineId: creditLine, toLineId: invoiceLine, amount: "45", sourceDocumentId: invoiceId },
            ],
          }),
        ),
      /source document/i,
    );
    assert.equal(await openBalance(org.orgId, invoiceLine), "45.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the panel's state reports what a credit settled and what is left", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "State reader", "admin"));
    const invoiceId = await postDoc(org, userId, "customer_invoice", "INV-STATE-1", "400");
    const creditId = await postDoc(org, userId, "customer_credit", "CM-STATE-1", "250");
    const invoiceLine = await openLineId(org.orgId, invoiceId);
    const creditLine = await openLineId(org.orgId, creditId);

    // Before any settlement: the whole credit is available and nothing is listed.
    const before = await withBypass(() => creditSettlementState(org.orgId, creditId));
    assert.equal(before!.lineId, creditLine);
    assert.equal(before!.amount, "250.0000");
    assert.equal(before!.applied, "0.0000");
    assert.equal(before!.open, "250.0000");
    assert.deepEqual(before!.settlements, []);

    const applied = await withBypass(() =>
      applyStandaloneCredits(org.orgId, userId, {
        partyId: org.customerId,
        side: "ar",
        appliedOn: org.date,
        credits: [
          { fromLineId: creditLine, toLineId: invoiceLine, amount: "150", sourceDocumentId: creditId },
        ],
      }),
    );

    // After: the remaining figure the panel shows and the balance the engine
    // checks against are the same `applications` rows, so they cannot drift.
    const after = await withBypass(() => creditSettlementState(org.orgId, creditId));
    assert.equal(after!.applied, "150.0000");
    assert.equal(after!.open, "100.0000");
    assert.equal(after!.settlements.length, 1);
    assert.equal(after!.settlements[0]!.applicationId, applied.applicationIds[0]);
    assert.equal(after!.settlements[0]!.documentNumber, "INV-STATE-1");
    assert.equal(after!.settlements[0]!.amount, "150.0000");

    // A released settlement leaves the list and returns its amount.
    await withBypass(() => unapplyCreditSettlement(org.orgId, userId, applied.applicationIds[0]!));
    const released = await withBypass(() => creditSettlementState(org.orgId, creditId));
    assert.equal(released!.open, "250.0000");
    assert.deepEqual(released!.settlements, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("an unposted credit has no settlement state to show", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Draft reader", "admin"));
    const draftId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${draftId}, ${org.orgId}, 'customer_credit', 'draft', 'CM-DRAFT-1',
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
                '50', '0', '50', ${userId})`);
    });
    // The panel keys off this null and renders nothing, rather than offering
    // an Apply button for a credit with no posted open item behind it.
    assert.equal(await withBypass(() => creditSettlementState(org.orgId, draftId)), null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

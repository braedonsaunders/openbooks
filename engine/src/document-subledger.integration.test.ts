import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { postDocument } from "./posting.ts";
import { applyInventoryIssuesForInvoice, applyInventoryReceiptsForBill, getOnHand } from "./inventory.ts";
import { createObligationsFromInvoice, runRevenueRecognition } from "./revenue-recognition.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = (await db.execute(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`)) as unknown as {
    rows: { bal: string }[];
  };
  return r.rows[0].bal;
}

/** Insert a draft document + one item line; return the document id. */
async function draftDoc(
  org: ScratchOrg,
  kind: string,
  number: string,
  line: {
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    stockLocationId?: string;
    accountId?: string;
    partyId?: string;
  },
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate,
                           status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, ${kind}, ${number}, ${line.partyId ?? null}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
            'draft', ${line.amount}, '0', ${line.amount}, false, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount,
                               is_billable, quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${line.itemId}, ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0',
            false, '0', '0', ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
  return docId;
}

test("document posting drives inventory receipts, COGS, and revenue recognition", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  };
  try {
    // -- Vendor bill → inventory receipt (via clearing) ----------------------
    const billId = await draftDoc(org, "vendor_bill", "BILL-1", {
      itemId: org.items.fifo,
      quantity: "50",
      unitPrice: "2",
      amount: "100",
      stockLocationId: org.stockLocationId,
      partyId: org.vendorId,
    });
    const billEntry = await postDocument(billId, deps);
    await applyInventoryReceiptsForBill(org.orgId, null, billId, billEntry, org.date, org.subsidiaryId);

    let onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.quantity), toUnits("50"));
    assert.equal(toUnits(onHand.value), toUnits("100"));
    // bill DR clearing 100 / CR AP 100, then receipt DR inventory 100 / CR clearing 100 → clearing nets to 0.
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.clearing)), 0n);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), toUnits("100"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), toUnits("-100"));

    // -- Customer invoice → COGS issue --------------------------------------
    const invId = await draftDoc(org, "customer_invoice", "INV-1", {
      itemId: org.items.fifo,
      quantity: "20",
      unitPrice: "5",
      amount: "100",
      stockLocationId: org.stockLocationId,
      accountId: org.accounts.revenue,
      partyId: org.customerId,
    });
    await postDocument(invId, deps);
    await applyInventoryIssuesForInvoice(org.orgId, null, invId, org.date, org.subsidiaryId);

    onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.quantity), toUnits("30")); // 50 − 20
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.cogs)), toUnits("40")); // 20 × 2
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), toUnits("60")); // 100 − 40
    // AR debited, revenue credited by the invoice.
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ar)), toUnits("100"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.revenue)), toUnits("-100"));

    // -- Customer invoice (service) → deferred → recognized ------------------
    const subId = await draftDoc(org, "customer_invoice", "INV-2", {
      itemId: org.items.service,
      quantity: "1",
      unitPrice: "1200",
      amount: "1200",
      accountId: org.accounts.revenue,
      partyId: org.customerId,
    });
    await postDocument(subId, deps);
    // Invoice posted to DEFERRED revenue (item carries a recognition rule).
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.deferred)), toUnits("-1200"));

    const created = await createObligationsFromInvoice(subId, org.orgId, null);
    assert.equal(created.created, 1);

    // Only July has an accounting period in the fixture → one $100 schedule line.
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", null);
    assert.equal(run.posted, 1);
    assert.equal(toUnits(run.totalAmount), toUnits("100")); // 1200 / 12
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.recognized)), toUnits("-100"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.deferred)), toUnits("-1100")); // 1200 − 100 drained

    // Idempotent: re-running recognizes nothing new.
    const rerun = await runRevenueRecognition(org.orgId, "2026-07-31", null);
    assert.equal(rerun.posted, 0);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.recognized)), toUnits("-100"));

    // Every posted entry balances.
    const bad = (await db.execute(sql`
      select entry_id from journal_lines where org_id = ${org.orgId} group by entry_id having sum(amount) <> 0`)) as unknown as {
      rows: unknown[];
    };
    assert.equal(bad.rows.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("percent-complete recognition posts current-period catch-ups and remains open until complete", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const ruleId = randomUUID();
    const contractId = randomUUID();
    const obligationId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'POC', 'Percent complete', 'percent_complete', false,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, total_transaction_price, currency)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'POC-1', 'active', '2026-07-01', '1000', 'CAD')`);
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id, allocated_price, percent_complete,
         recognition_starts_on, deferred_account_id, recognized_account_id, status)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Implementation', ${ruleId}, '1000', '25',
              '2026-07-01', ${org.accounts.deferred}, ${org.accounts.recognized}, 'open')`);
    await db.execute(sql`
      insert into recognition_schedules (id, org_id, obligation_id, book_id, status, total_amount)
      values (${scheduleId}, ${org.orgId}, ${obligationId}, ${org.bookId}, 'planned', '1000')`);
    await db.execute(sql`
      insert into recognition_schedule_lines (id, org_id, schedule_id, period_id, sequence, planned_amount)
      values (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 1, '250')`);

    const first = await runRevenueRecognition(org.orgId, "2026-07-15", null, obligationId);
    assert.equal(first.posted, 1);
    assert.equal(toUnits(first.totalAmount), toUnits("250"));
    let state = (await db.execute(sql`
      select o.status, e.posting_date::text as posting_date
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines l on l.schedule_id = s.id
        join journal_entries e on e.id = l.journal_entry_id
       where o.id = ${obligationId} and l.sequence = 1`)) as unknown as {
      rows: { status: string; posting_date: string }[];
    };
    assert.deepEqual(state.rows[0], {
      status: "open",
      posting_date: "2026-07-15",
    });

    await db.execute(sql`
      update performance_obligations set percent_complete = '100' where id = ${obligationId}`);
    await db.execute(sql`
      insert into recognition_schedule_lines (id, org_id, schedule_id, period_id, sequence, planned_amount)
      values (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 2, '750')`);

    const final = await runRevenueRecognition(org.orgId, "2026-07-20", null, obligationId);
    assert.equal(final.posted, 1);
    assert.equal(toUnits(final.totalAmount), toUnits("750"));
    state = (await db.execute(sql`
      select o.status, e.posting_date::text as posting_date
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines l on l.schedule_id = s.id
        join journal_entries e on e.id = l.journal_entry_id
       where o.id = ${obligationId} and l.sequence = 2`)) as unknown as {
      rows: { status: string; posting_date: string }[];
    };
    assert.deepEqual(state.rows[0], {
      status: "satisfied",
      posting_date: "2026-07-20",
    });
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.deferred)), toUnits("1000"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.recognized)), toUnits("-1000"));

    const rerun = await runRevenueRecognition(org.orgId, "2026-07-20", null, obligationId);
    assert.equal(rerun.posted, 0);
    const unbalanced = (await db.execute(sql`
      select entry_id from journal_lines where org_id = ${org.orgId}
       group by entry_id having sum(amount) <> 0`)) as unknown as {
      rows: unknown[];
    };
    assert.equal(unbalanced.rows.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

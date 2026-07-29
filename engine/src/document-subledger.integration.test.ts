import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { postDocument } from "./posting.ts";
import { applyInventoryIssuesForInvoice, applyInventoryReceiptsForBill, getOnHand } from "./inventory.ts";
import { runRevenueRecognition } from "./revenue-recognition.ts";
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
    documentProjectId?: string;
    lineProjectId?: string;
    documentLocationId?: string;
    lineLocationId?: string;
  },
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate,
                           status, subtotal, tax_total, total, project_id, location_id,
                           is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, ${kind}, ${number}, ${line.partyId ?? null}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
            'approved', ${line.amount}, '0', ${line.amount}, ${line.documentProjectId ?? null},
            ${line.documentLocationId ?? null}, false, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount,
                               project_id, location_id, is_billable, quantity_fulfilled, quantity_billed,
                               stock_location_id, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${line.itemId}, ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0',
            ${line.lineProjectId ?? null}, ${line.lineLocationId ?? null}, false, '0', '0',
            ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
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
    const projectId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'REVREC-PROJECT',
              'Revenue recognition project', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    const subId = await draftDoc(org, "customer_invoice", "INV-2", {
      itemId: org.items.service,
      quantity: "1",
      unitPrice: "1200",
      amount: "1200",
      accountId: org.accounts.revenue,
      partyId: org.customerId,
      documentProjectId: projectId,
      documentLocationId: org.locationId,
    });
    await postDocument(subId, deps);
    // Invoice posted to DEFERRED revenue (item carries a recognition rule).
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.deferred)), toUnits("-1200"));

    const obligations = (await db.execute(sql`
      select count(*)::int as n
        from performance_obligations
       where org_id = ${org.orgId}
         and document_line_id in (
           select id from document_lines where document_id = ${subId}
         )
    `)) as unknown as { rows: { n: number }[] };
    assert.equal(obligations.rows[0]?.n, 1);

    // Only July has an accounting period in the fixture → one $100 schedule line.
    const concurrentRuns = await Promise.all([
      runRevenueRecognition(org.orgId, "2026-07-31", null),
      runRevenueRecognition(org.orgId, "2026-07-31", null),
    ]);
    assert.equal(concurrentRuns.reduce((count, run) => count + run.posted, 0), 1);
    assert.equal(
      concurrentRuns.reduce((amount, run) => amount + toUnits(run.totalAmount), 0n),
      toUnits("100"),
    ); // 1200 / 12, exactly once
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.recognized)), toUnits("-100"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.deferred)), toUnits("-1100")); // 1200 − 100 drained
    const recognitionDimensions = (await db.execute(sql`
      select distinct jl.project_id, jl.location_id
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines rsl on rsl.schedule_id = s.id
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where o.org_id = ${org.orgId} and o.document_line_id in (
         select id from document_lines where document_id = ${subId}
       )`)) as unknown as {
      rows: { project_id: string | null; location_id: string | null }[];
    };
    assert.deepEqual(recognitionDimensions.rows, [{
      project_id: projectId,
      location_id: org.locationId,
    }]);

    // Idempotent: re-running recognizes nothing new.
    const rerun = await runRevenueRecognition(org.orgId, "2026-07-31", null);
    assert.equal(rerun.posted, 0);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.recognized)), toUnits("-100"));

    // A line dimension explicitly overrides the invoice header for every
    // downstream recognition entry.
    const overrideProjectId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${overrideProjectId}, ${org.orgId}, ${org.subsidiaryId}, 'REVREC-OVERRIDE',
              'Revenue recognition override', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    const secondLocation = (await db.execute(sql`
      select location_id from stock_locations
       where id = ${org.stockLocationId2} and org_id = ${org.orgId}`)) as unknown as {
      rows: { location_id: string }[];
    };
    const overrideLocationId = secondLocation.rows[0].location_id;
    const overrideInvoiceId = await draftDoc(org, "customer_invoice", "INV-3", {
      itemId: org.items.service,
      quantity: "1",
      unitPrice: "2400",
      amount: "2400",
      accountId: org.accounts.revenue,
      partyId: org.customerId,
      documentProjectId: projectId,
      lineProjectId: overrideProjectId,
      documentLocationId: org.locationId,
      lineLocationId: overrideLocationId,
    });
    await postDocument(overrideInvoiceId, deps);
    const overrideObligation = (await db.execute(sql`
      select id
        from performance_obligations
       where org_id = ${org.orgId}
         and document_line_id in (
           select id from document_lines where document_id = ${overrideInvoiceId}
         )
       limit 1
    `)) as unknown as { rows: { id: string }[] };
    assert.ok(overrideObligation.rows[0]?.id);
    const overrideRun = await runRevenueRecognition(
      org.orgId,
      "2026-07-31",
      null,
      overrideObligation.rows[0]!.id,
    );
    assert.equal(overrideRun.posted, 1);
    const overrideDimensions = (await db.execute(sql`
      select distinct jl.project_id, jl.location_id
        from recognition_schedule_lines rsl
        join recognition_schedules s on s.id = rsl.schedule_id
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where s.obligation_id = ${overrideObligation.rows[0]!.id}`)) as unknown as {
      rows: { project_id: string | null; location_id: string | null }[];
    };
    assert.deepEqual(overrideDimensions.rows, [{
      project_id: overrideProjectId,
      location_id: overrideLocationId,
    }]);

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
    const projectId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'POC-PROJECT',
              'Percent-complete project', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'POC', 'Percent complete', 'percent_complete', false,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, project_id, contract_number, status, starts_on, total_transaction_price, currency)
      values (${contractId}, ${org.orgId}, ${org.customerId}, ${projectId}, 'POC-1',
              'active', '2026-07-01', '1000', 'CAD')`);
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
    const firstDimensions = (await db.execute(sql`
      select distinct jl.project_id
        from recognition_schedule_lines rsl
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where rsl.schedule_id = ${scheduleId} and rsl.sequence = 1`)) as unknown as {
      rows: { project_id: string | null }[];
    };
    assert.deepEqual(firstDimensions.rows, [{ project_id: projectId }]);

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

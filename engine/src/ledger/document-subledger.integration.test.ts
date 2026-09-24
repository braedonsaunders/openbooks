import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "./posting-document.ts";
import { PostingError } from "./posting-contracts.ts";
import { applyInventoryIssuesForInvoice } from "../inventory/documents-sales.ts";
import { applyInventoryReceiptsForBill } from "../inventory/documents-purchasing.ts";
import { getOnHand } from "../inventory/position.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { runRevenueRecognition } from "../revenue/recognition.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`));
  return r.rows[0]!.bal;
}

/** Provision the remaining months of the service item's 12-month term. */
async function seedRecognitionTermPeriods(org: ScratchOrg): Promise<void> {
  const calendar = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id
      from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}
  `);
  const fiscalCalendarId = calendar.rows[0]?.fiscal_calendar_id;
  assert.ok(fiscalCalendarId);
  const periods = [
    [2026, 8, "2026-08-01", "2026-08-31"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 10, "2026-10-01", "2026-10-31"],
    [2026, 11, "2026-11-01", "2026-11-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
    [2027, 1, "2027-01-01", "2027-01-31"],
    [2027, 2, "2027-02-01", "2027-02-28"],
    [2027, 3, "2027-03-01", "2027-03-31"],
    [2027, 4, "2027-04-01", "2027-04-30"],
    [2027, 5, "2027-05-01", "2027-05-31"],
    [2027, 6, "2027-06-01", "2027-06-30"],
  ] as const;
  for (const [fiscalYear, periodNumber, startsOn, endsOn] of periods) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${randomUUID()}, ${org.orgId}, ${fiscalCalendarId}, ${fiscalYear},
              ${periodNumber}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
              false, '{}'::jsonb)
    `);
  }
}

/** Insert a draft document + item lines (approved on return); return the document id. */
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
    lineDepartmentId?: string;
  },
  extraLines: {
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    stockLocationId?: string;
    accountId?: string;
  }[] = [],
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate,
                           status, subtotal, tax_total, total, project_id, location_id,
                           is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, ${kind}, ${number}, ${line.partyId ?? null}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
            'draft', ${line.amount}, '0', ${line.amount}, ${line.documentProjectId ?? null},
            ${line.documentLocationId ?? null}, false, '{}'::jsonb, '{}'::jsonb)`);
  const insertLine = (
    lineNumber: number,
    itemId: string,
    accountId: string | null | undefined,
    quantity: string,
    unitPrice: string,
    amount: string,
  ) => db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount,
                               department_id, project_id, location_id, is_billable, quantity_fulfilled, quantity_billed,
                               stock_location_id, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, ${lineNumber}, ${itemId}, ${accountId ?? null}, ${quantity}, ${unitPrice}, ${amount}, '0',
            ${line.lineDepartmentId ?? null}, ${line.lineProjectId ?? null}, ${line.lineLocationId ?? null}, false, '0', '0',
            ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
  await insertLine(1, line.itemId, line.accountId, line.quantity, line.unitPrice, line.amount);
  let lineNumber = 2;
  for (const extra of extraLines) {
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount,
                                 department_id, project_id, location_id, is_billable, quantity_fulfilled, quantity_billed,
                                 stock_location_id, custom, tax_overridden, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${docId}, ${lineNumber}, ${extra.itemId}, ${extra.accountId ?? null},
              ${extra.quantity}, ${extra.unitPrice}, ${extra.amount}, '0',
              null, null, null, false, '0', '0',
              ${extra.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
    lineNumber++;
  }
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${docId} and org_id = ${org.orgId}
  `);
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
    await seedRecognitionTermPeriods(org);
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

    const obligations = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from performance_obligations
       where org_id = ${org.orgId}
         and document_line_id in (
           select id from document_lines where document_id = ${subId}
         )
    `));
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
    const recognitionDimensions = (await db.execute<{ project_id: string | null; location_id: string | null }>(sql`
      select distinct jl.project_id, jl.location_id
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines rsl on rsl.schedule_id = s.id
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where o.org_id = ${org.orgId} and o.document_line_id in (
         select id from document_lines where document_id = ${subId}
       )`));
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
    const secondLocation = (await db.execute<{ location_id: string }>(sql`
      select location_id from stock_locations
       where id = ${org.stockLocationId2} and org_id = ${org.orgId}`));
    const overrideLocationId = secondLocation.rows[0]!.location_id;
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
    const overrideObligation = (await db.execute<{ id: string }>(sql`
      select id
        from performance_obligations
       where org_id = ${org.orgId}
         and document_line_id in (
           select id from document_lines where document_id = ${overrideInvoiceId}
         )
       limit 1
    `));
    assert.ok(overrideObligation.rows[0]?.id);
    const overrideRun = await runRevenueRecognition(
      org.orgId,
      "2026-07-31",
      null,
      overrideObligation.rows[0]!.id,
    );
    assert.equal(overrideRun.posted, 1);
    const overrideDimensions = (await db.execute<{ project_id: string | null; location_id: string | null }>(sql`
      select distinct jl.project_id, jl.location_id
        from recognition_schedule_lines rsl
        join recognition_schedules s on s.id = rsl.schedule_id
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where s.obligation_id = ${overrideObligation.rows[0]!.id}`));
    assert.deepEqual(overrideDimensions.rows, [{
      project_id: overrideProjectId,
      location_id: overrideLocationId,
    }]);

    // Every posted entry balances.
    const bad = (await db.execute(sql`
      select entry_id from journal_lines where org_id = ${org.orgId} group by entry_id having sum(amount) <> 0`));
    assert.equal(bad.rows.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("standalone invoice with a lot-tracked line is refused by name before posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  };
  try {
    await db.execute(sql`
      update item_inventory_profiles set tracking = 'lot'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}
    `);
    const invId = await draftDoc(org, "customer_invoice", "INV-LOT-REFUSED", {
      itemId: org.items.fifo,
      quantity: "5",
      unitPrice: "5",
      amount: "25",
      stockLocationId: org.stockLocationId,
      accountId: org.accounts.revenue,
      partyId: org.customerId,
    });
    // The lot-tracked line names no lot, so posting must refuse by name
    // before the journal commits — revenue with no COGS was the old shape.
    await assert.rejects(
      () => postDocument(invId, deps),
      (error: unknown) =>
        error instanceof PostingError &&
        /lot-tracked item requires lot evidence/.test(error.message) &&
        /standalone-invoice lines/.test(error.message) &&
        /sales-fulfillment/.test(error.message),
    );
    // Refused before posting: still approved, no entry stamped, no movement.
    const residue = (await db.execute<{ status: string; posted_entry_id: string | null; movements: number }>(sql`
      select (select status::text from documents where id = ${invId} and org_id = ${org.orgId}) as status,
             (select posted_entry_id from documents where id = ${invId} and org_id = ${org.orgId}) as posted_entry_id,
             (select count(*)::int from inventory_movements m
               join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
              where l.document_id = ${invId} and m.org_id = ${org.orgId}) as movements`)).rows[0];
    assert.deepEqual(residue, { status: "approved", posted_entry_id: null, movements: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("standalone-invoice drain is atomic: a line-2 failure commits no line-1 COGS", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "2",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    // Line 2 is lot-tracked with no lot: the pre-post guard would refuse
    // this document, so the drain is driven directly — the shape a legacy
    // half-posted invoice presents to the post-commit effects retry.
    // (The component item is FIFO: moving-average profiles cannot track
    // lots under item_inventory_profiles_tracking_costing.)
    await db.execute(sql`
      update item_inventory_profiles set tracking = 'lot'
       where org_id = ${org.orgId} and item_id = ${org.items.component}
    `);
    const invId = await draftDoc(org, "customer_invoice", "INV-ATOMIC", {
      itemId: org.items.fifo,
      quantity: "5",
      unitPrice: "5",
      amount: "25",
      stockLocationId: org.stockLocationId,
      accountId: org.accounts.revenue,
      partyId: org.customerId,
    }, [{
      itemId: org.items.component,
      quantity: "1",
      unitPrice: "5",
      amount: "5",
      stockLocationId: org.stockLocationId,
      accountId: org.accounts.revenue,
    }]);
    await assert.rejects(
      () => applyInventoryIssuesForInvoice(org.orgId, null, invId, org.date, org.subsidiaryId),
      /lot-tracked item requires a lot/,
    );
    // One transaction for all lines: line 1's issue rolled back with line 2.
    const residue = (await db.execute<{ movements: number; on_hand: string }>(sql`
      select (select count(*)::int from inventory_movements m
               join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
              where l.document_id = ${invId} and m.org_id = ${org.orgId}) as movements,
             (select coalesce(sum(quantity), 0)::text from inventory_movements
               where org_id = ${org.orgId} and item_id = ${org.items.fifo} and status = 'posted') as on_hand`)).rows[0]!;
    assert.equal(residue.movements, 0);
    assert.equal(toUnits(residue.on_hand), toUnits("10"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("standalone-invoice COGS legs carry the line dimensions", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  };
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "2",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const departmentId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${org.orgId}, 'Field crews')`);
    const projectId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'DIM-PROJECT',
              'Dimension project', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    const invId = await draftDoc(org, "customer_invoice", "INV-DIMS", {
      itemId: org.items.fifo,
      quantity: "4",
      unitPrice: "5",
      amount: "20",
      stockLocationId: org.stockLocationId,
      accountId: org.accounts.revenue,
      partyId: org.customerId,
      lineDepartmentId: departmentId,
      lineProjectId: projectId,
      lineLocationId: org.locationId,
    });
    await postDocument(invId, deps);
    // The drain already ran inside posting; the manual re-drain replays.
    const replayed = await applyInventoryIssuesForInvoice(org.orgId, null, invId, org.date, org.subsidiaryId);
    assert.equal(replayed, 0);
    // Exactly one issue movement across both runs, and both COGS legs carry
    // the same department/project/location as the line.
    const legs = (await db.execute<{ department_id: string | null; project_id: string | null; location_id: string | null; movements: number }>(sql`
      select distinct jl.department_id, jl.project_id, jl.location_id,
             (select count(*)::int from inventory_movements m2
               join document_lines l2 on l2.id = m2.document_line_id and l2.org_id = m2.org_id
              where l2.document_id = ${invId} and m2.org_id = ${org.orgId} and m2.kind = 'issue') as movements
        from journal_lines jl
        join inventory_movements m on m.journal_entry_id = jl.entry_id and m.org_id = jl.org_id
        join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
       where l.document_id = ${invId} and m.org_id = ${org.orgId} and m.kind = 'issue'`)).rows;
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.movements, 1);
    assert.deepEqual(
      { department_id: legs[0]!.department_id, project_id: legs[0]!.project_id, location_id: legs[0]!.location_id },
      {
        department_id: departmentId,
        project_id: projectId,
        location_id: org.locationId,
      },
    );
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
    let state = (await db.execute<{ status: string; posting_date: string }>(sql`
      select o.status, e.posting_date::text as posting_date
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines l on l.schedule_id = s.id
        join journal_entries e on e.id = l.journal_entry_id
       where o.id = ${obligationId} and l.sequence = 1`));
    assert.deepEqual(state.rows[0], {
      status: "open",
      posting_date: "2026-07-15",
    });
    const firstDimensions = (await db.execute<{ project_id: string | null }>(sql`
      select distinct jl.project_id
        from recognition_schedule_lines rsl
        join journal_lines jl on jl.entry_id = rsl.journal_entry_id
       where rsl.schedule_id = ${scheduleId} and rsl.sequence = 1`));
    assert.deepEqual(firstDimensions.rows, [{ project_id: projectId }]);

    await db.execute(sql`
      update performance_obligations set percent_complete = '100' where id = ${obligationId}`);
    await db.execute(sql`
      insert into recognition_schedule_lines (id, org_id, schedule_id, period_id, sequence, planned_amount)
      values (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 2, '750')`);

    const final = await runRevenueRecognition(org.orgId, "2026-07-20", null, obligationId);
    assert.equal(final.posted, 1);
    assert.equal(toUnits(final.totalAmount), toUnits("750"));
    state = (await db.execute<{ status: string; posting_date: string }>(sql`
      select o.status, e.posting_date::text as posting_date
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join recognition_schedule_lines l on l.schedule_id = s.id
        join journal_entries e on e.id = l.journal_entry_id
       where o.id = ${obligationId} and l.sequence = 2`));
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
       group by entry_id having sum(amount) <> 0`));
    assert.equal(unbalanced.rows.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

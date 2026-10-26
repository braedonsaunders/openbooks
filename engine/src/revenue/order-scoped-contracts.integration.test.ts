import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { endOfMonth } from "../platform/civil-date.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { cancelRevenueRecognitionForInvoice } from "../ledger/revenue-recognition-cancellation.ts";
import {
  contractPosition,
  createObligationsFromInvoice,
  ensureBookingContract,
  runRevenueRecognition,
} from "./recognition.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function enableRevenueContracts(orgId: string, booking: boolean): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || '{"features": {"revenueContracts": true}}'::jsonb
      || ${booking ? '{"revenue": {"contractCreation": "booking"}}' : '{"revenue": {}}'}::jsonb
     where id = ${orgId}`);
}

async function disableRevenueContracts(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      coalesce(settings, '{}'::jsonb), '{features,revenueContracts}', 'false'::jsonb)
     where id = ${orgId}`);
}

/** Monthly periods covering the whole multi-year deal. */
async function seedDealPeriods(org: Org): Promise<void> {
  const calendar = (
    await db.execute<{ fiscal_calendar_id: string }>(
      sql`
    select fiscal_calendar_id from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}`,
      "objects",
    )
  )[0];
  assert.ok(calendar?.fiscal_calendar_id);
  for (let year = 2026; year <= 2029; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if (year === 2026 && month < 7) continue;
      if (year === 2029 && month > 7) continue;
      const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
      const endsOn = endOfMonth(startsOn);
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (${randomUUID()}, ${org.orgId}, ${calendar.fiscal_calendar_id},
                ${year}, ${month}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
                false, '{}'::jsonb)
        on conflict do nothing`);
    }
  }
}

/** A point-in-time setup-fee item beside the fixture's 12-month service item. */
async function seedSetupItem(org: Org, adminId: string): Promise<string> {
  const ruleId = randomUUID();
  await db.execute(sql`
    insert into recognition_rules
      (id, org_id, code, name, method, is_forecast, recognition_periods,
       start_date_source, end_date_source, period_offset, start_offset_days,
       initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
    values (${ruleId}, ${org.orgId}, 'SETUP-PIT', 'Setup fee point in time',
            'point_in_time', false, 1, 'obligation', 'term', 0, 0, '0',
            ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
  const itemId = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom,
                       create_plans_on, revenue_allocation, income_account_id,
                       recognition_rule_id, deferred_account_id,
                       standalone_selling_price, created_by, updated_by)
    values (${itemId}, ${org.orgId}, 'service', 'Onboarding setup', false, true,
            '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue},
            ${ruleId}, ${org.accounts.deferred}, '4000', ${adminId}, ${adminId})`);
  await db.execute(sql`
    update items set standalone_selling_price = '12000'
     where org_id = ${org.orgId} and id = ${org.items.service}`);
  return itemId;
}

async function seedSalesOrder(
  org: Org,
  adminId: string,
  setupItemId: string,
  number: string,
): Promise<{ orderId: string; lineIds: string[] }> {
  const orderId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       custom, extra_dims, created_by, updated_by)
    values (${orderId}, ${org.orgId}, 'sales_order', ${number},
            ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD',
            'draft', 39000, 0, 39000,
            '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})`);
  const lineIds: string[] = [];
  const lines = [
    { item: setupItemId, amount: "3000" },
    { item: org.items.service, amount: "12000" },
    { item: org.items.service, amount: "12000" },
    { item: org.items.service, amount: "12000" },
  ];
  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    const lineId = randomUUID();
    lineIds.push(lineId);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, description,
         quantity, unit_price, amount, tax_amount, custom, extra_dims,
         created_by, updated_by)
      values (${lineId}, ${org.orgId}, ${orderId}, ${lineNumber}, ${line.item},
              ${`Year ${lineNumber} service`}, '1', ${line.amount}, ${line.amount},
              '0', '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})`);
  }
  const approved = await db.execute<{ id: string }>(
    sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${orderId} and org_id = ${org.orgId} and status = 'draft'
    returning id`,
    "objects",
  );
  assert.equal(approved.length, 1);
  return { orderId, lineIds };
}

async function postOrderInvoice(
  org: Org,
  adminId: string,
  orderId: string,
  number: string,
  documentDate: string,
  amounts: { itemId: string; amount: string }[],
): Promise<string> {
  const documentId = randomUUID();
  const total = amounts.reduce((sum, line) => sum + Number(line.amount), 0);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${number},
            ${org.customerId}, ${org.subsidiaryId}, ${documentDate},
            ${documentDate}, ${documentDate}, 'CAD', 1, 'draft',
            ${total}, 0, ${total}, false,
            '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})`);
  let lineNumber = 0;
  for (const line of amounts) {
    lineNumber += 1;
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, custom, tax_overridden,
         extra_dims, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${lineNumber},
              ${line.itemId}, ${org.accounts.revenue}, 1, ${line.amount},
              ${line.amount}, 0, false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
              ${adminId}, ${adminId})`);
  }
  await db.execute(sql`
    insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
    values (${org.orgId}, ${orderId}, ${documentId}, 'bills', ${adminId}, ${adminId})`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(
    documentId,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: adminId, source: "test" } },
  );
  return documentId;
}

async function allocatedSum(orgId: string, contractId: string): Promise<string> {
  const rows = await db.execute<{ allocated_price: string }>(
    sql`
    select allocated_price from performance_obligations
     where org_id = ${orgId} and contract_id = ${contractId}`,
    "objects",
  );
  return rows.reduce(
    (sum, row) => (Number(sum) + Number(row.allocated_price)).toFixed(4),
    "0.0000",
  );
}

/**
 * A three-year sales order billed annually with an upfront setup fee is one
 * order-scoped contract: allocation across its obligations sums exactly to
 * billed consideration, and the net position tracks billings against
 * recognition after every step. With the gate off the same billings produce
 * one contract per invoice.
 */
test("order-scoped revenue contracts accumulate annual billings", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = (await seedFlowActors(org.orgId)).adminId;
    await seedDealPeriods(org);
    const setupItemId = await seedSetupItem(org, adminId);
    await enableRevenueContracts(org.orgId, true);

    const { orderId } = await seedSalesOrder(org, adminId, setupItemId, "SO-3YR-001");

    // Booking creates the shell before any billing: draft, no consideration.
    const shellId = await ensureBookingContract(org.orgId, orderId, adminId);
    assert.ok(shellId);
    const shell = (
      await db.execute<{
        scope: string;
        status: string;
        total_consideration: string;
        source_document_id: string;
      }>(
        sql`select scope, status, total_consideration::text, source_document_id
              from revenue_contracts where id = ${shellId} and org_id = ${org.orgId}`,
        "objects",
      )
    )[0];
    assert.equal(shell?.scope, "order");
    assert.equal(shell?.status, "draft");
    assert.equal(shell?.total_consideration, "0.0000");
    assert.equal(shell?.source_document_id, orderId);
    assert.equal(await ensureBookingContract(org.orgId, orderId, adminId), shellId);

    // Year one bills the setup fee plus the first annual term.
    await postOrderInvoice(org, adminId, orderId, "INV-Y1", "2026-07-15", [
      { itemId: setupItemId, amount: "3000" },
      { itemId: org.items.service, amount: "12000" },
    ]);
    const contracts = await db.execute<{
      id: string;
      status: string;
      total_consideration: string;
      modification_seq: number;
    }>(
      sql`
      select id, status, total_consideration::text, modification_seq from revenue_contracts
       where org_id = ${org.orgId}`,
      "objects",
    );
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0]!.id, shellId);
    assert.equal(contracts[0]!.status, "active");
    assert.equal(contracts[0]!.total_consideration, "15000.0000");
    assert.equal(contracts[0]!.modification_seq, 1);
    // Relative-SSP pricing (setup 4000 vs annual 12000 over a 15000 bundle)
    // lands 3750/11250 and sums exactly to the billed amount.
    assert.equal(await allocatedSum(org.orgId, shellId), "15000.0000");
    assert.equal(
      (
        await db.execute<{ amount: string }>(
          sql`
      select amount::text as amount from revenue_contract_billings
       where org_id = ${org.orgId} and contract_id = ${shellId}`,
          "objects",
        )
      ).length,
      1,
    );

    await runRevenueRecognition(org.orgId, "2026-07-31", adminId);
    let position = await contractPosition(db, org.orgId, shellId);
    // Setup recognized at once (3750) plus July's slice of year one (937.50);
    // billings run ahead, so the contract shows a liability.
    assert.equal(position.billed, "15000.0000");
    assert.equal(position.recognized, "4687.5000");
    assert.equal(position.side, "liability");
    assert.equal(position.net, "10312.5000");

    // Year two attaches to the same contract and grows consideration.
    await postOrderInvoice(org, adminId, orderId, "INV-Y2", "2027-07-15", [
      { itemId: org.items.service, amount: "12000" },
    ]);
    const yearTwo = await db.execute<{
      id: string;
      total_consideration: string;
      modification_seq: number;
    }>(
      sql`
      select id, total_consideration::text, modification_seq from revenue_contracts
       where org_id = ${org.orgId}`,
      "objects",
    );
    assert.equal(yearTwo.length, 1);
    assert.equal(yearTwo[0]!.id, shellId);
    assert.equal(yearTwo[0]!.total_consideration, "27000.0000");
    assert.equal(yearTwo[0]!.modification_seq, 2);
    assert.equal(await allocatedSum(org.orgId, shellId), "27000.0000");

    await runRevenueRecognition(org.orgId, "2027-07-31", adminId);
    position = await contractPosition(db, org.orgId, shellId);
    assert.equal(position.billed, "27000.0000");
    assert.equal(position.recognized, "16000.0000");
    assert.equal(position.side, "liability");
    assert.equal(position.net, "11000.0000");

    // Year three settles the contract: everything billed is recognized.
    await postOrderInvoice(org, adminId, orderId, "INV-Y3", "2028-07-15", [
      { itemId: org.items.service, amount: "12000" },
    ]);
    await runRevenueRecognition(org.orgId, "2029-07-31", adminId);
    position = await contractPosition(db, org.orgId, shellId);
    assert.equal(position.billed, "39000.0000");
    assert.equal(position.recognized, "39000.0000");
    assert.equal(position.remaining, "0.0000");
    assert.equal(position.side, "settled");
    assert.equal(await allocatedSum(org.orgId, shellId), "39000.0000");

    // The gate off keeps the scoped contract's data but returns new billings
    // to one contract per invoice.
    await disableRevenueContracts(org.orgId);
    const { orderId: order2 } = await seedSalesOrder(org, adminId, setupItemId, "SO-3YR-002");
    await postOrderInvoice(org, adminId, order2, "INV-Y1-B", "2026-07-15", [
      { itemId: org.items.service, amount: "12000" },
    ]);
    await postOrderInvoice(org, adminId, order2, "INV-Y2-B", "2027-07-15", [
      { itemId: org.items.service, amount: "12000" },
    ]);
    const scoped = await db.execute<{ scope: string }>(
      sql`
      select scope from revenue_contracts where org_id = ${org.orgId} order by created_at`,
      "objects",
    );
    assert.deepEqual(
      scoped.map((row) => row.scope),
      ["order", "invoice", "invoice"],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "cancelling one order billing preserves sibling recognition and uses its active fiscal calendar",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const adminId = (await seedFlowActors(org.orgId)).adminId;
      await seedDealPeriods(org);
      const setupItemId = await seedSetupItem(org, adminId);
      await enableRevenueContracts(org.orgId, false);
      const { orderId } = await seedSalesOrder(org, adminId, setupItemId, "SO-CANCEL-SCOPE");
      const firstInvoiceId = await postOrderInvoice(
        org,
        adminId,
        orderId,
        "INV-CANCEL-Y1",
        "2026-07-15",
        [{ itemId: org.items.service, amount: "12000" }],
      );
      const targetInvoiceId = await postOrderInvoice(
        org,
        adminId,
        orderId,
        "INV-CANCEL-Y2",
        "2027-07-15",
        [{ itemId: org.items.service, amount: "12000" }],
      );
      const contractId = (
        await db.execute<{ contract_id: string }>(
          sql`
      select contract_id from revenue_contract_billings
       where org_id = ${org.orgId} and document_id = ${firstInvoiceId}`,
          "objects",
        )
      )[0]?.contract_id;
      assert.ok(contractId);
      assert.equal(
        (
          await db.execute<{ contract_id: string }>(
            sql`
      select contract_id from revenue_contract_billings
       where org_id = ${org.orgId} and document_id = ${targetInvoiceId}`,
            "objects",
          )
        )[0]?.contract_id,
        contractId,
      );

      await runRevenueRecognition(org.orgId, "2026-07-31", adminId);
      await runRevenueRecognition(org.orgId, "2027-07-31", adminId);

      // An inactive planning calendar overlaps the reversal date and begins
      // earlier, so a date-only period lookup would select it.
      const inactiveCalendarId = randomUUID();
      await db.execute(sql`
      insert into fiscal_calendars
        (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
         adjustment_period_enabled, is_default, is_active, config)
      values (${inactiveCalendarId}, ${org.orgId}, 'Inactive planning calendar',
              'monthly', 1, 1, 'UTC', false, false, false, '{}'::jsonb)`);
      const inactivePeriodId = randomUUID();
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${inactivePeriodId}, ${org.orgId}, ${inactiveCalendarId}, 2027, 6,
              'Inactive overlap', '2027-06-01', '2027-08-31', false, '{}'::jsonb)`);
      const activePeriodId = (
        await db.execute<{ id: string }>(
          sql`
      select p.id from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_default and fc.is_active
       where p.org_id = ${org.orgId} and p.starts_on <= '2027-07-31'
         and p.ends_on >= '2027-07-31' and not p.is_adjustment`,
          "objects",
        )
      )[0]?.id;
      assert.ok(activePeriodId);

      const cancelled = await cancelRevenueRecognitionForInvoice({
        documentId: targetInvoiceId,
        orgId: org.orgId,
        actorId: adminId,
        reason: "The second annual service term was cancelled",
        reversalDate: "2027-07-31",
        allowedSubsidiaryIds: null,
      });
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.recognitionReversalEntryIds.length > 0);

      const obligations = await db.execute<{ document_id: string; status: string }>(
        sql`
      select line.document_id, obligation.status
        from performance_obligations obligation
        join document_lines line
          on line.id = obligation.document_line_id and line.org_id = obligation.org_id
       where obligation.org_id = ${org.orgId} and obligation.contract_id = ${contractId}
       order by line.document_id`,
        "objects",
      );
      assert.ok(
        obligations.some((row) => row.document_id === firstInvoiceId && row.status !== "cancelled"),
      );
      assert.ok(
        obligations.some(
          (row) => row.document_id === targetInvoiceId && row.status === "cancelled",
        ),
      );

      const reversalIds = `{${cancelled.recognitionReversalEntryIds.join(",")}}`;
      const reversalPeriods = await db.execute<{ period_id: string }>(
        sql`
      select period_id from journal_entries
       where org_id = ${org.orgId} and id = any(${reversalIds}::uuid[])`,
        "objects",
      );
      assert.ok(reversalPeriods.length > 0);
      assert.ok(reversalPeriods.every((row) => row.period_id === activePeriodId));
      assert.ok(reversalPeriods.every((row) => row.period_id !== inactivePeriodId));

      const contract = (
        await db.execute<{
          status: string;
          total_transaction_price: string;
          total_consideration: string;
        }>(
          sql`select status, total_transaction_price::text, total_consideration::text
             from revenue_contracts where id = ${contractId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0];
      assert.equal(contract?.status, "active");
      assert.equal(contract?.total_transaction_price, "12000.0000");
      assert.equal(contract?.total_consideration, "12000.0000");
      const position = await contractPosition(db, org.orgId, contractId);
      assert.equal(position.billed, "12000.0000");
      assert.equal(position.recognized, "12000.0000");
      assert.equal(position.remaining, "0.0000");
      const invoiceStates = await db.execute<{ id: string; status: string }>(
        sql`
      select id, status from documents where org_id = ${org.orgId}
       and id in (${firstInvoiceId}, ${targetInvoiceId})`,
        "objects",
      );
      assert.equal(invoiceStates.find((row) => row.id === firstInvoiceId)?.status, "posted");
      assert.equal(invoiceStates.find((row) => row.id === targetInvoiceId)?.status, "voided");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

/**
 * One billing document belongs to exactly one contract: an invoice that
 * bills two sales orders is refused by name before anything is written.
 */
test("scoped billing refuses an invoice billing two orders", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = (await seedFlowActors(org.orgId)).adminId;
    await seedDealPeriods(org);
    const setupItemId = await seedSetupItem(org, adminId);
    await enableRevenueContracts(org.orgId, false);
    const first = await seedSalesOrder(org, adminId, setupItemId, "SO-A");
    const second = await seedSalesOrder(org, adminId, setupItemId, "SO-B");

    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, subtotal, tax_total, total,
         custom, extra_dims, created_by, updated_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-TWO-ORDERS',
              ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft',
              24000, 0, 24000, '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, custom, extra_dims,
         created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, 1,
              ${org.items.service}, ${org.accounts.revenue}, 2, 12000, 24000, 0,
              '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})`);
    for (const order of [first.orderId, second.orderId]) {
      await db.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
        values (${org.orgId}, ${order}, ${documentId}, 'bills', ${adminId}, ${adminId})`);
    }
    await assert.rejects(
      createObligationsFromInvoice(documentId, org.orgId, adminId),
      /bill each order on its own invoice/,
    );
    assert.equal(
      (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from revenue_contracts where org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.n,
      0,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

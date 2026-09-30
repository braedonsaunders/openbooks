/**
 * Revenue from contracts with customers — ASC 606 / IFRS 15.
 *
 * The two standards are converged on every requirement exercised here, so each
 * case cites both. No text from either standard appears in this file; the
 * `requirement` line is our own restatement of the cited paragraph.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgContext,withBypassContext } from "../../platform/db.ts";
import { add, fromUnits, toUnits } from "../../money/money.ts";
import { parseMoney, parseQuantity, parseRate } from "../../money/brands.ts";
import { postDocument } from "../../ledger/posting-document.ts";
import {
  allocateByRelativeSSP,
  computeRecognitionSchedule,
  estimateVariableConsideration,
  runRevenueRecognition,
  separateFinancingComponent,
} from "../../revenue/recognition.ts";
import { measureRevenueModificationGroup } from "../../revenue/contract-modification-measurement.ts";
import { seedFlowActors,seedApprovalFlow } from '../../testing/fixtures.ts';
import { submitFinancialChange } from '../../flows/financial-changes-adapter.ts';
import { decideGate } from '../../flows/gates.ts';
import { proposeExpectedBreakage,applyExpectedBreakage } from '../../revenue/prepaid-breakage.ts';
import { createPrepaidGrant } from "../../billing/usage/prepaid.ts";
import { commitRateRun } from "../../billing/usage/rate-run.ts";
import { createUsageMeter, ingestUsageRecords } from "../../billing/usage/records.ts";
import {
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
} from "../../billing/usage/rating-plans.ts";
import { aggregateUsage, commitShortfall, rateUsage } from "../../billing/usage/rating.ts";
import { commitWindowForRun } from "../../billing/usage/true-ups.ts";
import {
  applyDropShipConfirmationInventory,
  attachDropShipPurchaseOrder,
  routeDropShipLine,
} from "../../sales/drop-ship.ts";
import { capture, deps, draftDocument, type DraftDocumentInput } from "../ledger-helpers.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

/**
 * Build a source document through its real draft lifecycle. The document-line
 * immutability guard permits ordinary line writes only while the header is
 * draft, so the fixture stages lines before approving and posting.
 */
async function postConformanceDocument(ctx: CaseContext, input: DraftDocumentInput): Promise<string> {
  const ledger = ctx.ledger!;
  await ensureRecognitionPeriods(ledger.orgId);
  const documentId = randomUUID();
  const date = input.date ?? ledger.date;
  const currency = input.currency ?? "CAD";
  const fxRate = input.fxRate ?? "1";
  const subtotal = fromUnits(input.lines.reduce((sum, line) => sum + toUnits(line.amount), 0n));

  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${documentId}, ${ledger.orgId}, ${input.kind}, ${input.number}, ${input.partyId ?? null},
            ${ledger.subsidiaryId}, ${date}, ${date}, ${currency}, ${fxRate}, 'draft',
            ${subtotal}, '0', ${subtotal}, false, '{}'::jsonb, '{}'::jsonb)`);

  for (const [index, line] of input.lines.entries()) {
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                  stock_location_id, custom, tax_overridden, extra_dims)
      values (${randomUUID()}, ${ledger.orgId}, ${documentId}, ${index + 1}, ${line.itemId ?? null},
              ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0',
              false, '0', '0', ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
  }

  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${ledger.orgId} and status = 'draft'`);
  return await postDocument(documentId, deps(ctx));
}

/** Provision periods spanning the twelve-month service fixtures. */
async function ensureRecognitionPeriods(orgId: string): Promise<void> {
  const calendar = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} limit 1`)).rows[0];
  if (!calendar) throw new Error("conformance tenant has no fiscal calendar");
  for (let month = 1; month <= 12; month++) {
    const mm = String(month).padStart(2, "0");
    const startsOn = `2027-${mm}-01`;
    const endsOn = new Date(Date.UTC(2027, month, 0)).toISOString().slice(0, 10);
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${orgId}, 2027, ${month}, ${`2027-${mm}`}, ${startsOn}, ${endsOn},
              false, ${calendar.id})
      on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing`);
  }
}

interface UsageCorpusFixture {
  meterId: string;
  meterKey: string;
  subscriptionId: string;
  linkId: string;
}

/** Create the minimum subscription and published meter setup used by usage cases. */
async function createUsageCorpusFixture(
  ctx: CaseContext,
  options: { commitAmount?: string } = {},
): Promise<UsageCorpusFixture> {
  const ledger = ctx.ledger!;
  const suffix = randomUUID().slice(0, 8);
  const itemId = randomUUID();
  const subscriptionPlanId = randomUUID();
  const subscriptionId = randomUUID();
  const enabled = await withOrgContext(ledger.orgId, () => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb)
        || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb, true)
     where id = ${ledger.orgId} returning id`));
  if (enabled.rows.length !== 1) throw new Error("usage conformance organization was not updated");
  await withOrgContext(ledger.orgId, async () => {
    const item = await db.execute(sql`
      insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
      values (${itemId}, ${ledger.orgId}, 'service', ${`Usage item ${suffix}`}, ${ctx.roles.revenue}, true, '{}'::jsonb)
      returning id`);
    if (item.rows.length !== 1) throw new Error("usage conformance item was not created");
    const plan = await db.execute(sql`
      insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
      values (${subscriptionPlanId}, ${ledger.orgId}, ${`Usage subscription ${suffix}`}, 0, 'CAD', 'monthly', 1)
      returning id`);
    if (plan.rows.length !== 1) throw new Error("usage conformance subscription plan was not created");
    const subscription = await db.execute(sql`
      insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on)
      values (${subscriptionId}, ${ledger.orgId}, ${ledger.customerId}, ${subscriptionPlanId}, 1, 'active', '2026-07-01', '2026-08-01')
      returning id`);
    if (subscription.rows.length !== 1) throw new Error("usage conformance subscription was not created");
  });

  const meterKey = `conformance-${suffix}`;
  const meter = await createUsageMeter(ledger.orgId, ledger.actorId, {
    key: meterKey,
    name: `Conformance usage ${suffix}`,
    unit: "request",
    aggregation: "sum",
    itemId,
  });
  const plan = await createUsageRatingPlan(ledger.orgId, ledger.actorId, {
    name: `Conformance plan ${suffix}`,
    currency: "CAD",
  });
  const version = await createUsageRatingPlanVersion(ledger.orgId, ledger.actorId, {
    planId: plan.id,
    effectiveFrom: "2026-07-01",
  });
  await replaceUsageRatingBands(ledger.orgId, ledger.actorId, version.id, [
    { meterId: meter.id, kind: "graduated", seq: 1, upToQty: "2", unitPrice: "1.25" },
    { meterId: meter.id, kind: "graduated", seq: 2, upToQty: null, unitPrice: "2.50" },
  ]);
  await publishUsagePlanVersion(ledger.orgId, ledger.actorId, version.id);
  const link = await createSubscriptionUsageLink(ledger.orgId, ledger.actorId, {
    subscriptionId,
    customerId: ledger.customerId,
    planVersionId: version.id,
    meterIds: [meter.id],
    effectiveFrom: "2026-07-01",
    commitAmount: options.commitAmount ?? null,
    commitPeriod: options.commitAmount === undefined ? null : "monthly",
    allowOverage: true,
  });
  return { meterId: meter.id, meterKey, subscriptionId, linkId: link.id };
}

async function ingestCorpusUsage(ctx: CaseContext, fixture: UsageCorpusFixture, quantity: string): Promise<void> {
  const ledger = ctx.ledger!;
  await ingestUsageRecords(ledger.orgId, ledger.actorId, [{
    meterKey: fixture.meterKey,
    customerId: ledger.customerId,
    subscriptionId: fixture.subscriptionId,
    occurredOn: ledger.date,
    quantity,
    source: "api",
    idempotencyKey: randomUUID(),
  }]);
}

async function postDraftUsageInvoice(ctx: CaseContext, invoiceId: string): Promise<void> {
  const orgId = ctx.ledger!.orgId;
  const approved = await db.execute(sql`
    update documents set status = 'approved'
     where org_id = ${orgId} and id = ${invoiceId} and status = 'draft'
     returning id`);
  if (approved.rows.length !== 1) throw new Error("usage invoice did not complete its approval transition");
  await postDocument(invoiceId, deps(ctx));
}

function ratedUsageTotal(quantity: string): string {
  const lines = rateUsage({
    quantity: parseQuantity(quantity),
    bands: [
      { kind: "graduated", seq: 1, upToQty: parseQuantity("2"), unitPrice: parseRate("1.25"), flatAmount: parseMoney("0"), includedQty: parseQuantity("0"), packageSize: null, packageRounding: null },
      { kind: "graduated", seq: 2, upToQty: null, unitPrice: parseRate("2.50"), flatAmount: parseMoney("0"), includedQty: parseQuantity("0"), packageSize: null, packageRounding: null },
    ],
  });
  return fromUnits(lines.reduce((sum, line) => sum + toUnits(line.amount), 0n));
}

export const REVENUE_CASES: readonly ConformanceCase[] = [
  // -------------------------------------------------------------------------
  // Step 4 — allocate the transaction price
  // -------------------------------------------------------------------------
  {
    id: "rev-allocate-relative-ssp",
    title: "Transaction price allocates in proportion to standalone selling prices",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-32-31",
        kind: "requirement",
        requirement:
          "An entity allocates the transaction price to each performance obligation in proportion to its standalone selling price.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.76",
        kind: "requirement",
        requirement:
          "The transaction price is allocated to each performance obligation on a relative standalone-selling-price basis.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A bundled contract splits across its performance obligations strictly in SSP proportion, and the split sums to the contract price with no residual cent.",
    facts: [
      "One contract with three performance obligations.",
      "Transaction price 100.00.",
      "Standalone selling prices 50.00, 25.00 and 75.00 (total 150.00).",
      "Proportions are 1/3, 1/6 and 1/2 of the transaction price.",
    ],
    expected: {
      values: {
        obligation1: "33.3333",
        obligation2: "16.6667",
        obligation3: "50.0000",
        sum: "100.0000",
      },
    },
    run: () => {
      const allocated = allocateByRelativeSSP("100.00", [
        { ssp: "50.00" },
        { ssp: "25.00" },
        { ssp: "75.00" },
      ]);
      return {
        values: {
          obligation1: allocated[0]!,
          obligation2: allocated[1]!,
          obligation3: allocated[2]!,
          sum: fromUnits(allocated.reduce((total, a) => total + toUnits(a), 0n)),
        },
      };
    },
  },

  {
    id: "rev-allocate-no-lost-cent",
    title: "Allocation of an indivisible price loses no consideration",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-32-28",
        kind: "requirement",
        requirement:
          "The objective of allocation is to assign the amount of consideration the entity expects to be entitled to for each performance obligation.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.73",
        kind: "requirement",
        requirement:
          "The transaction price is allocated to performance obligations to depict the consideration the entity expects for transferring each.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Allocating a price that does not divide evenly still assigns the entire transaction price — the residual is placed deterministically, never dropped or invented.",
    facts: [
      "Transaction price 1,000.00 across three performance obligations with equal standalone selling prices.",
      "One third of 1,000.00 is not representable at four decimal places.",
      "The residual unit is assigned to the first obligation by the largest-remainder rule.",
    ],
    expected: {
      values: {
        obligation1: "333.3334",
        obligation2: "333.3333",
        obligation3: "333.3333",
        sum: "1000.0000",
      },
    },
    run: () => {
      const allocated = allocateByRelativeSSP("1000.00", [
        { ssp: "1" },
        { ssp: "1" },
        { ssp: "1" },
      ]);
      return {
        values: {
          obligation1: allocated[0]!,
          obligation2: allocated[1]!,
          obligation3: allocated[2]!,
          sum: fromUnits(allocated.reduce((total, a) => total + toUnits(a), 0n)),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Step 5 — recognise revenue as obligations are satisfied
  // -------------------------------------------------------------------------
  {
    id: "rev-over-time-ratable",
    title: "An obligation satisfied evenly over time recognises revenue ratably",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-27",
        kind: "requirement",
        requirement:
          "An entity recognises revenue over time when the customer simultaneously receives and consumes the benefits as the entity performs.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.35",
        kind: "requirement",
        requirement:
          "Revenue is recognised over time where the customer simultaneously receives and consumes the benefits of the entity's performance.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A twelve-month service obligation recognises an equal amount each month and exactly the contract amount in total — the schedule never over- or under-recognises.",
    facts: [
      "Obligation amount 1,200.00.",
      "Service term of twelve months beginning 2026-01-01.",
      "Benefits are consumed evenly, so progress is measured by elapsed time.",
    ],
    expected: {
      values: {
        periods: "12",
        month1: "100.0000",
        month12: "100.0000",
        cumulativeAtEnd: "1200.0000",
      },
    },
    run: () => {
      const plan = computeRecognitionSchedule({
        total: "1200.00",
        method: "straight_line_even",
        startOn: "2026-01-01",
        termPeriods: 12,
      });
      return {
        values: {
          periods: String(plan.length),
          month1: plan[0]!.planned,
          month12: plan[plan.length - 1]!.planned,
          cumulativeAtEnd: plan[plan.length - 1]!.cumulative,
        },
      };
    },
  },

  {
    id: "rev-uneven-term-sums-exactly",
    title: "A term that does not divide evenly still recognises the full amount",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-31",
        kind: "requirement",
        requirement:
          "Revenue recognised over time must depict the entity's performance in transferring control, measured by a single method applied consistently.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.39",
        kind: "requirement",
        requirement:
          "A single method of measuring progress is applied to each performance obligation satisfied over time.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Cumulative revenue over an indivisible term equals the contract amount exactly; rounding is absorbed within the schedule rather than left as a residual.",
    facts: [
      "Obligation amount 1,000.00 recognised over seven months from 2026-01-01.",
      "One seventh of 1,000.00 is not representable at four decimal places.",
    ],
    expected: {
      values: { periods: "7", cumulativeAtEnd: "1000.0000" },
    },
    run: () => {
      const plan = computeRecognitionSchedule({
        total: "1000.00",
        method: "straight_line_even",
        startOn: "2026-01-01",
        termPeriods: 7,
      });
      const sum = fromUnits(plan.reduce((total, line) => total + toUnits(line.planned), 0n));
      if (sum !== plan[plan.length - 1]!.cumulative) {
        throw new Error(`schedule cumulative ${plan[plan.length - 1]!.cumulative} != sum of periods ${sum}`);
      }
      return {
        values: { periods: String(plan.length), cumulativeAtEnd: plan[plan.length - 1]!.cumulative },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Presentation — contract liability, and the ledger consequence
  // -------------------------------------------------------------------------
  {
    id: "rev-contract-liability-then-recognition",
    title: "Billing ahead of performance creates a contract liability that unwinds as performance occurs",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-45-2",
        kind: "requirement",
        requirement:
          "When a customer is billed before the entity performs, the entity presents a contract liability rather than revenue.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.106",
        kind: "requirement",
        requirement:
          "Consideration billed before performance is presented as a contract liability until the entity performs.",
      },
      {
        standard: "ASC 606",
        reference: "606-10-25-27",
        kind: "requirement",
        requirement:
          "Revenue is recognised as the performance obligation is satisfied over time.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Invoicing a twelve-month service up front posts nothing to revenue — it raises a receivable and a contract liability — and the first month's performance moves exactly one twelfth out of that liability into revenue.",
    facts: [
      "A twelve-month service obligation is invoiced in full for 1,200.00 on 2026-07-15.",
      "The item carries a straight-line twelve-period recognition rule.",
      "Recognition is run as at 2026-07-31, the end of the first service month.",
    ],
    expected: {
      entries: [
        {
          step: "invoice",
          lines: [
            { role: "ar", amount: "1200.0000" },
            { role: "deferredRevenue", amount: "-1200.0000" },
          ],
        },
        {
          step: "month 1 recognition",
          lines: [
            { role: "deferredRevenue", amount: "100.0000" },
            { role: "recognizedRevenue", amount: "-100.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const invoice = await capture(ctx, "invoice", async () => {
        await postConformanceDocument(ctx, {
          kind: "customer_invoice",
          number: "CONF-REV-1",
          partyId: ledger.customerId,
          lines: [
            {
              itemId: ledger.items.service,
              accountId: ctx.roles.revenue,
              quantity: "1",
              unitPrice: "1200",
              amount: "1200",
            },
          ],
        });
      });

      const recognition = await capture(ctx, "month 1 recognition", async () => {
        await runRevenueRecognition(ledger.orgId, "2026-07-31", ledger.actorId);
      });

      return { entries: [invoice, recognition] };
    },
  },

  {
    id: "rev-recognition-is-idempotent",
    title: "Re-running recognition for a period recognises nothing further",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-27",
        kind: "requirement",
        requirement:
          "Revenue for a period is recognised once, as the obligation is satisfied in that period.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Running the recognition process twice for the same period does not double-recognise revenue — a control an auditor tests directly when the process is automated or re-run after a correction.",
    facts: [
      "A twelve-month service obligation of 1,200.00 invoiced on 2026-07-15.",
      "Recognition is run for 2026-07-31, then run again for the same date.",
    ],
    expected: {
      entries: [
        {
          step: "first recognition run",
          lines: [
            { role: "deferredRevenue", amount: "100.0000" },
            { role: "recognizedRevenue", amount: "-100.0000" },
          ],
        },
        { step: "second recognition run", lines: [] },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await postConformanceDocument(ctx, {
        kind: "customer_invoice",
        number: "CONF-REV-2",
        partyId: ledger.customerId,
        lines: [
          {
            itemId: ledger.items.service,
            accountId: ctx.roles.revenue,
            quantity: "1",
            unitPrice: "1200",
            amount: "1200",
          },
        ],
      });

      const first = await capture(ctx, "first recognition run", async () => {
        await runRevenueRecognition(ledger.orgId, "2026-07-31", ledger.actorId);
      });
      const second = await capture(ctx, "second recognition run", async () => {
        await runRevenueRecognition(ledger.orgId, "2026-07-31", ledger.actorId);
      });
      return { entries: [first, second] };
    },
  },

  {
    id: "rev-obligation-created-per-line",
    title: "Each revenue line becomes a tracked performance obligation",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-14",
        kind: "requirement",
        requirement:
          "At contract inception an entity identifies each promised good or service that is distinct as a separate performance obligation.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.22",
        kind: "requirement",
        requirement:
          "Each distinct promised good or service in a contract is identified as a separate performance obligation.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The system creates and retains an identified performance obligation for each distinct promise, which is the record an auditor inspects when testing the completeness of the revenue schedule.",
    facts: ["One invoice with a single distinct twelve-month service promise."],
    expected: { values: { obligations: "1" } },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const documentId = await postConformanceDocument(ctx, {
        kind: "customer_invoice",
        number: "CONF-REV-3",
        partyId: ledger.customerId,
        lines: [
          {
            itemId: ledger.items.service,
            accountId: ctx.roles.revenue,
            quantity: "1",
            unitPrice: "600",
            amount: "600",
          },
        ],
      }).then(async () => {
        const row = (await db.execute<{ id: string }>(sql`
          select id from documents where org_id = ${ledger.orgId} and document_number = 'CONF-REV-3'`));
        return row.rows[0]!.id;
      });

      const rows = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from performance_obligations
         where org_id = ${ledger.orgId}
           and document_line_id in (select id from document_lines where document_id = ${documentId})`));
      return { values: { obligations: String(rows.rows[0]!.n) } };
    },
  },

  {
    id: "rev-variable-consideration-constraint",
    title: "Variable consideration is constrained to the amount not subject to significant reversal",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-32-11",
        kind: "requirement",
        requirement:
          "An entity includes variable consideration in the transaction price only to the extent it is probable that a significant revenue reversal will not occur.",
      },
      {
        standard: "ASC 606",
        reference: "606-10-32-8",
        kind: "requirement",
        requirement:
          "Variable consideration is estimated using either the expected value or the most likely amount, whichever better predicts the entitled consideration.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.56",
        kind: "requirement",
        requirement:
          "Variable consideration is included in the transaction price only to the extent that it is highly probable no significant reversal will occur.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A contingent bonus is estimated by the stated method, the constraint caps what enters the transaction price, and the held-back amount is carried explicitly — so revenue can never include consideration management has judged subject to significant reversal.",
    facts: [
      "Fixed consideration 100,000.00 plus a 20,000.00 bonus contingent on early completion.",
      "The bonus has two outcomes — earned (60%) or not (40%) — so the most-likely-amount method estimates 20,000.00.",
      "Management concludes only 12,000.00 of the bonus meets the constraint.",
      "The transaction price is therefore 112,000.00, with 8,000.00 constrained out until the uncertainty resolves.",
    ],
    expected: {
      values: {
        estimate: "20000.0000",
        transactionPrice: "112000.0000",
        constrainedOut: "8000.0000",
      },
    },
    run: () => {
      const variable = estimateVariableConsideration({
        method: "most_likely_amount",
        outcomes: [
          { amount: "20000", probabilityPercent: "60" },
          { amount: "0", probabilityPercent: "40" },
        ],
        constraintLimit: "12000",
      });
      return {
        values: {
          estimate: variable.estimate,
          transactionPrice: add("100000", variable.constrained),
          constrainedOut: variable.constrainedOut,
        },
      };
    },
  },

  {
    id: "rev-series-usage-allocation",
    title: "Hosted-service usage is allocated to the month that supplied it",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-14–15; 606-10-32-39–41; 606-10-55-18",
        kind: "requirement",
        requirement:
          "A hosted service is a series of distinct monthly promises, and variable consideration that matches a month's value is allocated to that month under the right-to-invoice expedient.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.22–23; IFRS 15.84–86; IFRS 15.B16",
        kind: "requirement",
        requirement:
          "A hosted service's usage price belongs to the distinct monthly service increment whose value it reflects, rather than being spread over later months.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The July usage is rated from its published bands, billed as a July invoice, and posts to receivables and usage revenue without a deferred balance.",
    facts: [
      "A hosted API service provides one distinct monthly service increment from 2026-07-01 through 2026-07-31.",
      "The customer records 3 requests on 2026-07-15; the first 2 cost 1.25 each and the next costs 2.50.",
      "The July usage invoice is 5.00, dated 2026-07-31, and no amount relates to a later service month.",
    ],
    expected: {
      entries: [{
        step: "July usage invoice",
        lines: [
          { role: "ar", amount: "5.0000" },
          { role: "revenue", amount: "-5.0000" },
        ],
      }],
      values: { ratedAmount: "5.0000", tracedLines: "2", lineTotal: "5.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const fixture = await createUsageCorpusFixture(ctx);
      await ingestCorpusUsage(ctx, fixture, "3");
      const rated = await commitRateRun(ledger.orgId, ledger.actorId, fixture.linkId, "2026-07-01", "2026-07-31");
      const invoiceId = rated.invoiceId;
      if (!invoiceId) throw new Error("rated usage did not produce an invoice");
      const invoice = await capture(ctx, "July usage invoice", async () => postDraftUsageInvoice(ctx, invoiceId));
      const rows = (await db.execute<{ tracedLines: number; lineTotal: string }>(sql`
        select count(*) filter (where custom->'rating'->>'runId' = ${rated.run.id})::int as "tracedLines",
               coalesce(sum(amount), 0)::text as "lineTotal"
          from document_lines where org_id = ${ledger.orgId} and document_id = ${invoiceId}`)).rows[0];
      if (!rows) throw new Error("usage invoice lines were not readable");
      return {
        entries: [invoice],
        values: {
          ratedAmount: rated.preview.totalRated,
          tracedLines: String(rows.tracedLines),
          lineTotal: rows.lineTotal,
        },
      };
    },
  },

  {
    id: "rev-usage-royalty",
    title: "A licence royalty is earned as the customer uses the intellectual property",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-65",
        kind: "requirement",
        requirement:
          "A sales- or usage-based royalty promised for a licence of intellectual property is recognised when the related use occurs.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B63",
        kind: "requirement",
        requirement:
          "A usage-based royalty on an intellectual-property licence is recognised as the customer's use takes place.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The rating kernel produces no amount before a licence is used and prices the first 4 uses at 3.25 each when that use occurs.",
    facts: [
      "The customer receives a licence to use intellectual property; this is not a hosted service.",
      "Before any use, the 0-use royalty is 0.00.",
      "The customer uses the licence 4 times on 2026-07-15 at 3.25 per use, creating a 13.00 royalty for July.",
    ],
    expected: { values: { beforeUse: "0.0000", usedQuantity: "4", royalty: "13.0000" } },
    run: () => {
      const band = {
        kind: "volume" as const,
        seq: 1,
        upToQty: null,
        unitPrice: parseRate("3.25"),
        flatAmount: parseMoney("0"),
        includedQty: parseQuantity("0"),
        packageSize: null,
        packageRounding: null,
      };
      const records = [{
        id: "licence-use-2026-07-15",
        occurredOn: "2026-07-15",
        quantity: parseQuantity("4"),
        distinctKey: null,
        reversesId: null,
      }];
      const amount = (quantity: ReturnType<typeof parseQuantity>): string =>
        fromUnits(rateUsage({ quantity, bands: [band] }).reduce((sum, line) => sum + toUnits(line.amount), 0n));
      return {
        values: {
          beforeUse: amount(aggregateUsage("sum", [])),
          usedQuantity: aggregateUsage("sum", records),
          royalty: amount(aggregateUsage("sum", records)),
        },
      };
    },
  },

  {
    id: "rev-prepaid-drawdown",
    title: "A usage prepayment remains a liability until the month's usage is drawn",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-45-2; 606-10-32-39–41",
        kind: "requirement",
        requirement:
          "Consideration invoiced before performance remains a contract liability, and usage consideration allocated to a monthly service is recognised as that service is transferred.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.106; IFRS 15.84–86",
        kind: "requirement",
        requirement:
          "A usage prepayment is a contract liability until the related monthly service is provided, when the amount for that service is released to revenue.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The prepaid invoice credits deferred revenue, and the rating run's 2026-07 draw drives the recognition run to release the same amount in July.",
    facts: [
      "A customer prepays 7.50 for a usage-based licence on 2026-07-15; the invoice is posted before the July usage occurs.",
      "The customer records 4 requests in July; the first 2 cost 1.25 each and the next 2 cost 2.50 each, for a 7.50 draw.",
      "The July usage draw is recognised by 2026-07-31, leaving 0.00 of this prepayment deferred.",
    ],
    expected: {
      entries: [
        { step: "prepaid invoice", lines: [{ role: "ar", amount: "7.5000" }, { role: "deferredRevenue", amount: "-7.5000" }] },
        { step: "July usage recognition", lines: [{ role: "deferredRevenue", amount: "7.5000" }, { role: "recognizedRevenue", amount: "-7.5000" }] },
      ],
      values: { drawn: "7.5000", draftUsageInvoice: "0", recognitionPosts: "1", recognized: "7.5000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const fixture = await createUsageCorpusFixture(ctx);
      const rule = await withOrgContext(ledger.orgId, () => db.execute<{ id: string }>(sql`
        select recognition_rule_id as id from items where org_id = ${ledger.orgId} and id = ${ledger.items.service}`));
      const ruleId = rule.rows[0]?.id;
      if (!ruleId) throw new Error("prepaid service item has no recognition rule");
      const changed = await withOrgContext(ledger.orgId, () => db.execute(sql`
        update recognition_rules set method = 'usage'
         where org_id = ${ledger.orgId} and id = ${ruleId} returning id`));
      if (changed.rows.length !== 1) throw new Error("prepaid recognition rule was not updated");

      const prepaidInvoice = await capture(ctx, "prepaid invoice", async () => {
        await postConformanceDocument(ctx, {
          kind: "customer_invoice",
          number: `CONF-USAGE-PREPAID-${randomUUID().slice(0, 8)}`,
          partyId: ledger.customerId,
          lines: [{ itemId: ledger.items.service, accountId: ctx.roles.revenue, quantity: "1", unitPrice: "7.50", amount: "7.50" }],
        });
      });
      const source = (await db.execute<{ id: string }>(sql`
        select dl.id from document_lines dl join documents d on d.org_id = dl.org_id and d.id = dl.document_id
         where dl.org_id = ${ledger.orgId} and d.document_number like 'CONF-USAGE-PREPAID-%'`)).rows[0];
      if (!source) throw new Error("posted prepaid invoice line was not readable");
      await createPrepaidGrant(ledger.orgId, ledger.actorId, {
        customerId: ledger.customerId,
        sourceDocumentLineId: source.id,
        amount: "7.50",
        currency: "CAD",
      });
      await ingestCorpusUsage(ctx, fixture, "4");

      let drawn = "";
      let invoiceId: string | null | undefined;
      let recognized = "";
      let posts = 0;
      const monthRecognition = await capture(ctx, "July usage recognition", async () => {
        const run = await commitRateRun(ledger.orgId, ledger.actorId, fixture.linkId, "2026-07-01", "2026-07-31");
        drawn = run.preview.prepaidDrawn;
        invoiceId = run.invoiceId;
        const recognition = await runRevenueRecognition(ledger.orgId, "2026-07-31", ledger.actorId);
        recognized = recognition.totalAmount;
        posts = recognition.posted;
      });
      return {
        entries: [prepaidInvoice, monthRecognition],
        values: { drawn, draftUsageInvoice: invoiceId === null ? "0" : "1", recognitionPosts: String(posts), recognized },
      };
    },
  },

  {
    id: "rev-minimum-commit",
    title: "A minimum usage commitment closes against the usage in its monthly window",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-48",
        kind: "requirement",
        requirement:
          "A minimum commitment's unused amount is accounted for when the customer's remaining right expires at the end of its commitment window.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B46",
        kind: "requirement",
        requirement:
          "An unexercised customer right is recognised when the entity no longer expects the customer to use it, rather than before that point.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The rating kernel measures the 5.00 usage against the 10.00 monthly minimum and computes the 5.00 shortfall for the window that ends on 2026-07-31.",
    facts: [
      "The customer has a nonrefundable minimum commitment of 10.00 for 2026-07-01 through 2026-07-31.",
      "The customer uses 3 requests in July; tier pricing makes the usage consideration 5.00.",
      "The window-end minimum shortfall is 5.00; no expected-breakage estimate is applied before the window closes.",
    ],
    expected: {
      values: {
        ratedUsage: "5.0000",
        minimum: "10.0000",
        shortfall: "5.0000",
        totalAtWindowEnd: "10.0000",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
      },
    },
    run: () => {
      const ratedUsage = ratedUsageTotal("3");
      const minimum = parseMoney("10.00");
      const shortfall = commitShortfall({ commitAmount: minimum, ratedInWindow: parseMoney(ratedUsage) });
      const window = commitWindowForRun("2026-07-01", "2026-07-31", "monthly" as const);
      if (!window) throw new Error("the monthly minimum commitment did not close in its window");
      return {
        values: {
          ratedUsage,
          minimum,
          shortfall,
          totalAtWindowEnd: add(ratedUsage, shortfall),
          windowStart: window.start,
          windowEnd: window.end,
        },
      };
    },
  },

  {
    id: "rev-expected-breakage-estimation",
    title: "Expected breakage is recognised in proportion to customer redemptions",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-48",
        kind: "requirement",
        requirement:
          "When expected breakage can be estimated, the entity recognises it in proportion to customers exercising their rights; otherwise it waits until further use becomes remote.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B46",
        kind: "requirement",
        requirement:
          "Expected unexercised rights are recognised in line with the pattern of exercised rights when that estimate is supportable.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "An independently approved, entitled estimate is recognised proportionally as customer rights are exercised; amounts owed to third parties remain liabilities.",
    facts: [
      "Customers pay 100.00 for 100 usage credits, and 60 credits have been exercised by 2026-07-31.",
      "The entity expects total breakage of 20.00, so 80 credits are expected to be redeemed; 60 of those 80 have been exercised.",
      "The proportionate breakage revenue is 20.00 × 60 / 80 = 15.00, subject to entitlement and the variable-consideration constraint.",
    ],
    expected: {entries:[{step:'expected breakage',lines:[{role:'deferredRevenue',amount:'15.0000'},{role:'recognizedRevenue',amount:'-15.0000'}]}],values:{proportionalBreakageRevenue:'15.0000'}},
    run:async ctx=> {
      const ledger=ctx.ledger!,fixture=await createUsageCorpusFixture(ctx)
      const actors=await withBypassContext(async()=> {
        const actors=await seedFlowActors(ledger.orgId)
        await db.execute(sql`update recognition_rules set method='usage' where org_id=${ledger.orgId} and id=(select recognition_rule_id from items where org_id=${ledger.orgId} and id=${ledger.items.service})`)
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values (${ledger.orgId},${actors.submitterId},'ar.post','grant')`)
        await seedApprovalFlow(ledger.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:actors.approver1Id}],mode:'any',preventSelfApproval:true})
        return actors
      })
      return withOrgContext(ledger.orgId,async()=> {
        await postConformanceDocument(ctx,{kind:'customer_invoice',number:'CONF-BREAKAGE',partyId:ledger.customerId,lines:[{itemId:ledger.items.service,accountId:ctx.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'}]})
        const source=(await db.execute<{id:string}>(sql`select line.id from document_lines line join documents document on document.org_id=line.org_id and document.id=line.document_id where line.org_id=${ledger.orgId} and document.document_number='CONF-BREAKAGE'`)).rows[0]!
        const grant=await createPrepaidGrant(ledger.orgId,ledger.actorId,{customerId:ledger.customerId,sourceDocumentLineId:source.id,amount:'100',currency:'CAD'})
        await ingestCorpusUsage(ctx,fixture,'25')
        const run=await commitRateRun(ledger.orgId,ledger.actorId,fixture.linkId,'2026-07-01','2026-07-31')
        if(run.preview.prepaidDrawn!=='60.0000')throw new Error('the native usage run did not exercise sixty of prepaid rights')
        const usage=await runRevenueRecognition(ledger.orgId,'2026-07-31',ledger.actorId)
        if(usage.problems.length)throw new Error(usage.problems.join('; '))
        const id=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{grantId:grant.id,effectiveOn:'2026-07-31',reason:'Recognize the supported expected breakage proportionally',idempotencyKey:randomUUID(),estimate:{method:'expected_proportional',expectedBreakage:'20',entitled:true,meetsReversalConstraint:true,thirdPartyObligation:false,evidence:'Redemption history supports twenty of expected breakage without significant reversal; legal review confirms entitlement and no unclaimed-property obligation.'}})
        await submitFinancialChange(ledger.orgId,id,actors.submitterId)
        const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${id} and status='pending'`)).rows[0]!
        await decideGate({gateId:gate.id,userId:actors.approver1Id,decision:'approved'})
        const measurement=await applyExpectedBreakage(ledger.orgId,id,actors.submitterId)
        const entry=await capture(ctx,'expected breakage',async()=>{const result=await runRevenueRecognition(ledger.orgId,'2026-07-31',ledger.actorId);if(result.problems.length)throw new Error(result.problems.join('; '))})
        return {entries:[entry],values:{proportionalBreakageRevenue:String(measurement.target)}}
      })
    },
  },

  {
    id: "rev-significant-financing-component",
    title: "A significant financing component is separated from revenue",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-32-15",
        kind: "requirement",
        requirement:
          "The promised consideration is adjusted for the time value of money when the contract contains a significant financing component.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.60",
        kind: "requirement",
        requirement:
          "The transaction price is adjusted for the effects of the time value of money where the contract contains a significant financing component.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Revenue on a contract paid materially in arrears is measured at the cash selling price — the promised amount discounted at the rate a separate financing would carry — and the difference accretes as interest, year by year, landing exactly on the billed amount.",
    facts: [
      "Consideration of 121,000.00 receivable two years after control transfers.",
      "A discount rate of 10% gives a cash selling price of 100,000.00.",
      "Revenue at inception is 100,000.00; 21,000.00 accretes as interest.",
      "Year one accretes 10,000.00 (10% of 100,000) and year two 11,000.00, carrying the receivable to exactly 121,000.00.",
    ],
    expected: {
      values: {
        revenueAtInception: "100000.0000",
        interestOverTerm: "21000.0000",
        year1Interest: "10000.0000",
        year2Interest: "11000.0000",
        receivableAtMaturity: "121000.0000",
      },
    },
    run: () => {
      const financing = separateFinancingComponent({
        consideration: "121000",
        annualRatePercent: "10",
        years: 2,
      });
      return {
        values: {
          revenueAtInception: financing.cashSellingPrice,
          interestOverTerm: financing.financingComponent,
          year1Interest: financing.accretion[0]!.interest,
          year2Interest: financing.accretion[1]!.interest,
          receivableAtMaturity: financing.accretion[1]!.closing,
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Changes in estimate and contract modifications (over-time contracts)
  // -------------------------------------------------------------------------
  {
    id: "rev-percent-complete-catch-up",
    title: "A change in the progress estimate is caught up in the current period",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-31",
        kind: "requirement",
        requirement:
          "Progress toward complete satisfaction of an over-time obligation is remeasured each period with a single method applied consistently.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.39",
        kind: "requirement",
        requirement:
          "A single method of measuring progress is applied to each over-time obligation and updated as circumstances change.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Revising the estimated progress restates the cumulative target and books only the delta in the current period — an upward revision recognises more, a downward revision reverses what was already recognised, and prior periods are never restated.",
    facts: [
      "Obligation amount 1,200.00 recognised by percentage of completion.",
      "In March the estimate rises to 60% complete with 500.00 already recognised: the cumulative target is 720.00, so 220.00 is recognised in March.",
      "In April the estimate falls to 40% complete with 720.00 recognised: the cumulative target is 480.00, so 240.00 is reversed in April.",
    ],
    expected: {
      values: {
        marchCatchUp: "220.0000",
        aprilReversal: "-240.0000",
      },
    },
    run: () => {
      const march = computeRecognitionSchedule({
        total: "1200.00",
        method: "percent_complete",
        startOn: "2026-03-01",
        percentComplete: "60",
        alreadyRecognized: "500",
      });
      const april = computeRecognitionSchedule({
        total: "1200.00",
        method: "percent_complete",
        startOn: "2026-04-01",
        percentComplete: "40",
        alreadyRecognized: "720",
      });
      return {
        values: {
          marchCatchUp: march[0]!.planned,
          aprilReversal: april[0]!.planned,
        },
      };
    },
  },

  {
    id: "rev-contract-modification",
    title: "A contract modification is assessed as a separate contract or as part of the existing one",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-10",
        kind: "requirement",
        requirement:
          "A change to the scope or price of a contract is accounted for as a separate contract when the added promises are distinct and priced at their standalone selling prices, and otherwise by remeasuring the existing obligation.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.18",
        kind: "requirement",
        requirement:
          "A contract modification is a separate contract only when distinct promises are added for consideration reflecting their standalone selling prices.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Adding distinct services at their standalone selling prices mid-contract creates a separate accounting unit, while other changes remeasure the existing obligation prospectively or with a cumulative catch-up.",
    facts: [
      "A twelve-month service for 1,200.00 (100.00 a month); 300.00 is recognised in the first three months.",
      "In month four the parties add distinct services priced at their standalone selling price of 900.00 over the remaining nine months.",
      "The modification is a separate contract: the original 100.00 a month continues and 100.00 a month is recognised for the added services.",
    ],
    async run() {
      const addition=measureRevenueModificationGroup({treatment:'separate',considerationChange:'900',existing:[],promises:[{ssp:'900',percentComplete:'0'}],remainingDistinct:true,additionsAtStandalonePrice:true});
      const added=computeRecognitionSchedule({total:addition.newTotal,method:'straight_line_even',startOn:'2026-04-01',endOn:'2026-12-31'});
      return {values:{recognizedToDate:'300.0000',originalMonthlyRecognition:'100.0000',addedMonthlyRecognition:added[0]!.planned,remainingTransactionPrice:add('900',addition.newTotal)}};
    },
    expected: {
      values: {
        recognizedToDate: "300.0000",
        originalMonthlyRecognition: "100.0000",
        addedMonthlyRecognition: "100.0000",
        remainingTransactionPrice: "1800.0000",
      },
    },
  },

  {
    id: "rev-drop-ship-principal-gross",
    title: "A drop-ship principal reports the customer sale and vendor cost gross",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-36 to 55-40",
        kind: "requirement",
        requirement:
          "An entity is a principal when it controls the specified good before transfer to the customer and reports the consideration gross; an agent arranges for another party to provide it.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B34-B38",
        kind: "requirement",
        requirement:
          "The principal controls the promised good before transfer and reports gross consideration, while an agent arranges for another party to provide the good and reports its fee.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "When the distributor controls the good before it reaches the customer, the customer invoice records gross revenue and the vendor shipment records its cost separately as cost of goods sold.",
    facts: [
      "The distributor controls one item before transfer and invoices the customer 100.00.",
      "The vendor's confirmed shipment has a recorded purchase value of 60.00.",
      "The customer invoice posts through the document kernel and the drop-ship confirmation posts through the inventory journal service without creating a stock movement.",
    ],
    expected: {
      entries: [
        {
          step: "customer invoice and vendor shipment",
          lines: [
            { role: "ar", amount: "100.0000" },
            { role: "revenue", amount: "-100.0000" },
            { role: "cogs", amount: "60.0000" },
            { role: "inventoryClearing", amount: "-60.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      // One controlled item for every leg of this case: the customer invoice,
      // the sales order, the purchase order, and the vendor receipt all derive
      // from this single binding, so a future edit cannot silently split the
      // principal and vendor legs across two different items again.
      const standardItemId = ledger.items.standard;
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"inventory":true,"dropShipping":true}'::jsonb)
         where id = ${ledger.orgId}
      `);
      // The distributor controls one stocked unit before transfer: an approved
      // sales order for the customer, routed to the vendor for direct shipment.
      const salesOrderId = randomUUID();
      const salesOrderLineId = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency, status)
        values (${salesOrderId}, ${ledger.orgId}, 'sales_order', 'CONF-REV-DS-ORDER',
         ${ledger.customerId}, ${ledger.subsidiaryId}, ${ledger.date}, 'CAD', 'draft')`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount, tax_amount, stock_location_id)
        values (${salesOrderLineId}, ${ledger.orgId}, ${salesOrderId}, 1, ${standardItemId},
         'Drop-ship unit', '1', 'ea', '100', '100', '0', ${ledger.stockLocationId})`);
      const salesOrderApproved = await db.execute<{ id: string }>(sql`
        update documents set status = 'approved'
         where id = ${salesOrderId} and org_id = ${ledger.orgId} and status = 'draft'
        returning id`);
      if (salesOrderApproved.rows.length !== 1) throw new Error("conformance drop-ship sales order was not approved");
      await routeDropShipLine({
        orgId: ledger.orgId,
        actorId: ledger.actorId,
        salesOrderId,
        salesOrderLineId,
        allowedSubsidiaryIds: null,
      });
      // The vendor's purchase order carries the same controlled item, so the
      // confirmation pairs the receipt line to the routed sales demand.
      const purchaseOrderId = randomUUID();
      const purchaseOrderLineId = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency, status)
        values (${purchaseOrderId}, ${ledger.orgId}, 'purchase_order', 'CONF-REV-DS-PO',
         ${ledger.vendorId}, ${ledger.subsidiaryId}, ${ledger.date}, 'CAD', 'draft')`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount, tax_amount)
        values (${purchaseOrderLineId}, ${ledger.orgId}, ${purchaseOrderId}, 1, ${standardItemId},
         'Drop-ship unit', '1', 'ea', '60', '60', '0')`);
      await attachDropShipPurchaseOrder({
        orgId: ledger.orgId,
        actorId: ledger.actorId,
        salesOrderId,
        purchaseOrderId,
        shipToAddress: { name: "Conformance customer" },
        lines: [{ salesOrderLineId, purchaseOrderLineId }],
        allowedSubsidiaryIds: null,
      });
      // A sales-order-backed invoice is fulfilment-governed: it records the
      // gross customer consideration without issuing the vendor-shipped stock.
      const invoiceDraftId = await draftDocument(ledger, {
        kind: "customer_invoice",
        number: "CONF-REV-DS-PRINCIPAL",
        partyId: ledger.customerId,
        lines: [
          {
            itemId: standardItemId,
            accountId: ctx.roles.revenue,
            quantity: "1",
            unitPrice: "100",
            amount: "100",
            stockLocationId: ledger.stockLocationId,
          },
        ],
      });
      await db.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
        values (${ledger.orgId}, ${salesOrderId}, ${invoiceDraftId}, 'bills', ${ledger.actorId}, ${ledger.actorId})`);
      const receiptId = randomUUID();
      const receiptLineId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
           currency, fx_rate, status, subtotal, tax_total, total, custom, extra_dims)
        values
          (${receiptId}, ${ledger.orgId}, 'purchase_receipt', 'CONF-REV-DS-RECEIPT', ${ledger.vendorId},
           ${ledger.subsidiaryId}, ${ledger.date}, ${ledger.date}, 'CAD', '1', 'draft',
           '60', '0', '60', '{"dropShipConfirmation":{"idempotencyKey":"conformance"}}'::jsonb, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, quantity, unit_price, amount, tax_amount,
           is_billable, quantity_fulfilled, quantity_billed, custom, extra_dims)
        values
          (${receiptLineId}, ${ledger.orgId}, ${receiptId}, 1, ${standardItemId},
           '1', '60', '60', '0', false, '0', '0',
           ${JSON.stringify({ receipt: { sourceLineId: purchaseOrderLineId, lotId: null, serialId: null } })}::jsonb,
           '{}'::jsonb)
      `);
      const receiptApproved = await db.execute<{ id: string }>(sql`
        update documents set status = 'approved'
         where id = ${receiptId} and org_id = ${ledger.orgId} and status = 'draft'
        returning id`);
      if (receiptApproved.rows.length !== 1) throw new Error("conformance drop-ship receipt was not approved");
      await db.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
        values (${ledger.orgId}, ${purchaseOrderId}, ${receiptId}, 'fulfills', ${ledger.actorId}, ${ledger.actorId})`);
      const invoiceEntry = await capture(ctx, "customer invoice", async () => {
        const approved = await db.execute<{ id: string }>(sql`
          update documents set status = 'approved'
           where id = ${invoiceDraftId} and org_id = ${ledger.orgId} and status = 'draft'
          returning id`);
        if (approved.rows.length !== 1) throw new Error("conformance invoice was not approved");
        await postDocument(invoiceDraftId, deps(ctx));
      });
      const confirmationEntry = await capture(ctx, "vendor shipment", async () => {
        await applyDropShipConfirmationInventory(db, ledger.orgId, ledger.actorId, receiptId);
      });
      return { entries: [{ step: "customer invoice and vendor shipment", lines: [...invoiceEntry.lines, ...confirmationEntry.lines] }] };
    },
  },

  {
    id: "rev-drop-ship-agent-net",
    title: "A drop-ship agent reports only its arranging fee",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-36 to 55-40",
        kind: "requirement",
        requirement:
          "An entity that arranges for another party to provide the specified good, without controlling it before transfer, reports its fee rather than the gross customer consideration.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B34-B38",
        kind: "requirement",
        requirement:
          "An agent that arranges for another party to provide the good does not control it before transfer and reports only the amount of its fee.",
      },
    ],
    support: "not-implemented",
    tier: "ledger",
    assertion:
      "When the distributor never controls the vendor's good and only arranges delivery, its revenue is the contracted fee rather than the full amount charged to the customer.",
    facts: [
      "The vendor controls and transfers the item directly to the customer.",
      "The customer pays 100.00 and the vendor is entitled to 80.00; the distributor earns a 20.00 arranging fee.",
      "The target outcome is 20.00 net revenue with no gross cost of goods sold presentation by the agent.",
    ],
    gap:
      "Drop-ship accounting currently records a distributor's customer invoice gross and its vendor cost as cost of goods sold. It has no principal-versus-agent assessment or net-fee recognition path for an entity that never controls the good before transfer.",
    expected: { values: { netRevenue: "20.0000", costOfGoodsSold: "0.0000" } },
  },
];

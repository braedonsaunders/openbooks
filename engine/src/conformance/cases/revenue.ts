/**
 * Revenue from contracts with customers — ASC 606 / IFRS 15.
 *
 * The two standards are converged on every requirement exercised here, so each
 * case cites both. No text from either standard appears in this file; the
 * `requirement` line is our own restatement of the cited paragraph.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { add, fromUnits, toUnits } from "../../money.ts";
import { postDocument } from "../../posting.ts";
import {
  allocateByRelativeSSP,
  computeRecognitionSchedule,
  estimateVariableConsideration,
  runRevenueRecognition,
  separateFinancingComponent,
} from "../../revenue-recognition.ts";
import { capture, deps, type DraftDocumentInput } from "../ledger-helpers.ts";
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
];

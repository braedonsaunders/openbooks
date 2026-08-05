/**
 * Leases — ASC 842 and IFRS 16.
 *
 * The lessee model is implemented in engine/src/leases.ts: liability at the
 * present value of unpaid payments, right-of-use asset at cost, exact-decimal
 * interest/principal/amortization schedules, the US GAAP operating single-cost
 * model, framework-resolved classification, and the short-term/low-value
 * elections. The initial-recognition and exemption cases run against the REAL
 * service and kernel; the schedule cases assert the same engine arithmetic the
 * service persists.
 *
 * The worked example throughout: five annual arrears payments of 20,000.00 at
 * 5%. Annuity factor 4.3294766708 → opening liability 86,589.5334.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { add, neg, toUnits, fromUnits } from "../../money.ts";
import {
  classifyLease,
  classifyLessorLease,
  commenceLease,
  createLeaseAgreement,
  lessorStraightLineSchedule,
  measureLesseeLease,
  postDueLeaseSchedules,
  salesTypeCommencement,
} from "../../leases.ts";
import { capture } from "../ledger-helpers.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

/** The lease-account bundle every ledger-tier lease case passes the service. */
function leaseAccounts(ctx: CaseContext) {
  return {
    rouAsset: ctx.roles.rouAsset,
    leaseLiability: ctx.roles.leaseLiability,
    interestExpense: ctx.roles.leaseInterestExpense,
    amortizationExpense: ctx.roles.rouAmortization,
    leaseExpense: ctx.roles.leaseExpense,
    payment: ctx.roles.bank,
  };
}

export const LEASE_CASES: readonly ConformanceCase[] = [
  {
    id: "lease-lessee-initial-recognition",
    title: "A lessee recognises a right-of-use asset and a lease liability at commencement",
    citations: [
      {
        standard: "ASC 842",
        reference: "842-20-30-1",
        kind: "requirement",
        requirement:
          "At the commencement date a lessee measures the lease liability at the present value of the lease payments not yet paid and measures the right-of-use asset accordingly.",
      },
      {
        standard: "IFRS 16",
        reference: "IFRS 16.26",
        kind: "requirement",
        requirement:
          "At the commencement date a lessee measures the lease liability at the present value of the lease payments not yet paid, discounted using the rate implicit in the lease or, if not readily determinable, the incremental borrowing rate.",
      },
      {
        standard: "IFRS 16",
        reference: "IFRS 16.23",
        kind: "requirement",
        requirement:
          "At the commencement date a lessee measures the right-of-use asset at cost.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Commencing a lease puts both an asset and a liability on the balance sheet at the exact present value of the payments — leased capacity and the obligation to pay for it are visible, not off balance sheet, and the discounting is exact to the hundredth of a cent.",
    facts: [
      "A five-year lease commencing 2026-07-15.",
      "Annual payments of 20,000.00 in arrears; 100,000.00 undiscounted in total.",
      "The incremental borrowing rate is 5%.",
      "The present value of the payments is 86,589.5334.",
    ],
    expected: {
      entries: [
        {
          step: "commencement",
          lines: [
            { role: "rouAsset", amount: "86589.5334" },
            { role: "leaseLiability", amount: "-86589.5334" },
          ],
        },
      ],
      values: { openingLiability: "86589.5334", undiscountedPayments: "100000.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const { leaseId } = await createLeaseAgreement(ledger.orgId, ledger.actorId, {
        subsidiaryId: ledger.subsidiaryId,
        leaseNumber: "CONF-LEASE-1",
        commencementOn: "2026-07-15",
        termPeriods: 5,
        paymentFrequency: "annual",
        paymentAmount: "20000",
        annualDiscountRatePercent: "5",
        classificationInputs: { transfersOwnership: true },
        accounts: leaseAccounts(ctx),
      });

      let commenced: Awaited<ReturnType<typeof commenceLease>>;
      const entry = await capture(ctx, "commencement", async () => {
        commenced = await commenceLease(ledger.orgId, leaseId, ledger.actorId);
      });

      const schedule = (await db.execute(sql`
        select coalesce(sum(payment), 0)::text as total from lease_agreement_schedule_lines
         where org_id = ${ledger.orgId} and lease_id = ${leaseId}`)) as unknown as {
        rows: { total: string }[];
      };
      return {
        entries: [entry],
        values: {
          openingLiability: commenced!.liability,
          undiscountedPayments: fromUnits(toUnits(schedule.rows[0]!.total)),
        },
      };
    },
  },

  {
    id: "lease-finance-interest-and-amortization",
    title: "A finance lease reports interest and amortisation separately",
    citations: [
      {
        standard: "ASC 842",
        reference: "842-20-25-5",
        kind: "requirement",
        requirement:
          "For a finance lease, a lessee recognises interest on the lease liability separately from amortisation of the right-of-use asset.",
      },
      {
        standard: "IFRS 16",
        reference: "IFRS 16.49",
        kind: "requirement",
        requirement:
          "A lessee presents interest expense on the lease liability separately from the depreciation charge on the right-of-use asset.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A finance lease produces a front-loaded total charge with the interest element presented in finance costs rather than operating expenses — the split that changes reported operating profit and every coverage ratio computed from it.",
    facts: [
      "Opening liability 86,589.5334 at 5%.",
      "Year one interest is 4,329.4767.",
      "The right-of-use asset amortises straight-line over five years; year one carries 17,317.9067.",
      "The 20,000.00 payment reduces the liability by 15,670.5233 after interest.",
      "Total year-one charge is 21,647.3834, more than the 20,000.00 cash paid.",
    ],
    expected: {
      entries: [
        {
          step: "year 1 payment",
          lines: [
            { role: "leaseInterestExpense", amount: "4329.4767" },
            { role: "leaseLiability", amount: "15670.5233" },
            { role: "bank", amount: "-20000.0000" },
          ],
        },
        {
          step: "year 1 amortisation",
          lines: [
            { role: "rouAmortization", amount: "17317.9067" },
            { role: "rouAsset", amount: "-17317.9067" },
          ],
        },
      ],
    },
    run: (ctx) => {
      const m = measureLesseeLease({
        payment: "20000",
        periods: 5,
        annualRatePercent: "5",
        periodsPerYear: 1,
        timing: "arrears",
        model: "finance",
      });
      const y1 = m.schedule[0]!;
      const principal = add(y1.payment, neg(y1.interest));
      return {
        entries: [
          {
            step: "year 1 payment",
            lines: [
              { accountId: ctx.roles.leaseInterestExpense, amount: y1.interest },
              { accountId: ctx.roles.leaseLiability, amount: principal },
              { accountId: ctx.roles.bank, amount: neg(y1.payment) },
            ],
          },
          {
            step: "year 1 amortisation",
            lines: [
              { accountId: ctx.roles.rouAmortization, amount: y1.amortization! },
              { accountId: ctx.roles.rouAsset, amount: neg(y1.amortization!) },
            ],
          },
        ],
      };
    },
  },

  {
    id: "lease-operating-single-cost",
    title: "A US GAAP operating lease reports a single straight-line lease cost",
    citations: [
      {
        standard: "ASC 842",
        reference: "842-20-25-6",
        kind: "requirement",
        requirement:
          "For an operating lease, a lessee recognises a single lease cost allocated over the lease term on a generally straight-line basis.",
      },
      {
        standard: "ASC 842",
        reference: "842-10-25-2",
        kind: "requirement",
        requirement:
          "A lessee classifies a lease as a finance lease when it meets any of the specified criteria, and as an operating lease otherwise.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A lease meeting no finance criterion classifies as operating under US GAAP and charges one flat amount to operating expense each year — while still carrying the asset and liability on the balance sheet, the liability unwinding on the interest method and the right-of-use asset absorbing the difference.",
    facts: [
      "The same five-year, 20,000.00-a-year lease at 5%.",
      "No classification criterion is met, so US GAAP classifies it as operating.",
      "Total lease cost is 100,000.00 over five years, 20,000.00 a year straight-line.",
      "Year one: imputed interest is 4,329.4767; the liability unwinds by 15,670.5233 and the right-of-use asset reduces by the same amount, keeping the two aligned.",
    ],
    expected: {
      entries: [
        {
          step: "year 1",
          lines: [
            { role: "leaseExpense", amount: "20000.0000" },
            { role: "bank", amount: "-20000.0000" },
            { role: "leaseLiability", amount: "15670.5233" },
            { role: "rouAsset", amount: "-15670.5233" },
          ],
        },
      ],
      values: { classification: "operating", annualStraightLineCost: "20000.0000" },
    },
    run: (ctx) => {
      const classification = classifyLease(
        { leaseTermMonths: 60, economicLifeMonths: 300, pvOfPayments: "86589.5334", fairValue: "400000" },
        "us_gaap",
      );
      const m = measureLesseeLease({
        payment: "20000",
        periods: 5,
        annualRatePercent: "5",
        periodsPerYear: 1,
        timing: "arrears",
        model: classification.model,
      });
      const y1 = m.schedule[0]!;
      return {
        entries: [
          {
            step: "year 1",
            lines: [
              { accountId: ctx.roles.leaseExpense, amount: y1.singleCost! },
              { accountId: ctx.roles.bank, amount: neg(y1.payment) },
              { accountId: ctx.roles.leaseLiability, amount: add(y1.payment, neg(y1.interest)) },
              { accountId: ctx.roles.rouAsset, amount: neg(y1.rouAdjustment!) },
            ],
          },
        ],
        values: { classification: classification.model, annualStraightLineCost: y1.singleCost! },
      };
    },
  },

  {
    id: "lease-ifrs-single-lessee-model",
    title: "IFRS applies one lessee model to every lease",
    citations: [
      {
        standard: "IFRS 16",
        reference: "IFRS 16.22",
        kind: "requirement",
        requirement:
          "At the commencement date a lessee recognises a right-of-use asset and a lease liability for every lease within scope, without classifying leases as operating or finance.",
      },
      {
        standard: "IFRS 16",
        reference: "IFRS 16.31",
        kind: "requirement",
        requirement:
          "A lessee depreciates the right-of-use asset applying the depreciation requirements for property, plant and equipment.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The identical lease produces a front-loaded charge under IFRS and a flat charge under US GAAP — the classification step is skipped entirely under IFRS, and a dual-reporting entity gets each framework's answer from the same source data by switching the configured framework.",
    facts: [
      "The same five-year, 20,000.00-a-year lease at 5%, meeting no US GAAP finance criterion.",
      "IFRS ignores the criteria and applies the single model: year one carries 4,329.4767 of interest plus 17,317.9067 of depreciation, totalling 21,647.3834.",
      "US GAAP classifies it operating: a flat 20,000.00 lease cost in the same year.",
      "The year-one difference between the frameworks is 1,647.3834.",
    ],
    expected: {
      values: {
        ifrsModel: "finance",
        usGaapModel: "operating",
        ifrsYear1Charge: "21647.3834",
        usGaapOperatingYear1Charge: "20000.0000",
        frameworkDifference: "1647.3834",
      },
    },
    run: () => {
      const criteria = {}; // no finance criterion met
      const ifrs = classifyLease(criteria, "ifrs");
      const usGaap = classifyLease(criteria, "us_gaap");
      const ifrsMeasure = measureLesseeLease({
        payment: "20000",
        periods: 5,
        annualRatePercent: "5",
        periodsPerYear: 1,
        timing: "arrears",
        model: ifrs.model,
      });
      const usMeasure = measureLesseeLease({
        payment: "20000",
        periods: 5,
        annualRatePercent: "5",
        periodsPerYear: 1,
        timing: "arrears",
        model: usGaap.model,
      });
      const ifrsY1 = add(ifrsMeasure.schedule[0]!.interest, ifrsMeasure.schedule[0]!.amortization!);
      const usY1 = usMeasure.schedule[0]!.singleCost!;
      return {
        values: {
          ifrsModel: ifrs.model,
          usGaapModel: usGaap.model,
          ifrsYear1Charge: ifrsY1,
          usGaapOperatingYear1Charge: usY1,
          frameworkDifference: add(ifrsY1, neg(usY1)),
        },
      };
    },
  },

  {
    id: "lease-short-term-and-low-value-exemption",
    title: "Short-term and low-value leases may be kept off balance sheet",
    citations: [
      {
        standard: "IFRS 16",
        reference: "IFRS 16.5",
        kind: "requirement",
        requirement:
          "A lessee may elect not to recognise a right-of-use asset and lease liability for short-term leases and for leases of low-value assets.",
      },
      {
        standard: "ASC 842",
        reference: "842-20-25-2",
        kind: "requirement",
        requirement:
          "A lessee may elect, by class of underlying asset, not to recognise a right-of-use asset and lease liability for short-term leases.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "An elected short-term lease recognises no asset or liability at commencement and charges rent straight to expense as paid — and the election is validated against eligibility, so a thirteen-month lease cannot quietly take it.",
    facts: [
      "A nine-month lease at 1,000.00 a month with no purchase option, commencing 2026-01-01.",
      "The short-term exemption is elected.",
      "Commencement recognises nothing; each month charges 1,000.00 to lease expense.",
      "The election is recorded on the lease as evidence of the policy applied.",
    ],
    expected: {
      entries: [
        { step: "commencement", lines: [] },
        {
          step: "month 1 rent",
          lines: [
            { role: "leaseExpense", amount: "1000.0000" },
            { role: "bank", amount: "-1000.0000" },
          ],
        },
      ],
      values: { rouAssetRecognised: "0.0000", leaseLiabilityRecognised: "0.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const { leaseId } = await createLeaseAgreement(ledger.orgId, ledger.actorId, {
        subsidiaryId: ledger.subsidiaryId,
        leaseNumber: "CONF-LEASE-ST",
        commencementOn: "2026-01-01",
        termPeriods: 9,
        paymentFrequency: "monthly",
        paymentAmount: "1000",
        annualDiscountRatePercent: "6",
        exemption: "short_term",
        accounts: leaseAccounts(ctx),
      });

      let commenced: Awaited<ReturnType<typeof commenceLease>>;
      const commencement = await capture(ctx, "commencement", async () => {
        commenced = await commenceLease(ledger.orgId, leaseId, ledger.actorId);
      });
      const month1 = await capture(ctx, "month 1 rent", async () => {
        await postDueLeaseSchedules(ledger.orgId, "2026-01-31", ledger.actorId);
      });

      return {
        entries: [commencement, month1],
        values: {
          rouAssetRecognised: fromUnits(toUnits(commenced!.rouAsset)),
          leaseLiabilityRecognised: fromUnits(toUnits(commenced!.liability)),
        },
      };
    },
  },

  {
    id: "lease-lessor-classification",
    title: "A lessor classifies each lease and accounts for it accordingly",
    citations: [
      {
        standard: "IFRS 16",
        reference: "IFRS 16.61",
        kind: "requirement",
        requirement:
          "A lessor classifies each of its leases as either an operating lease or a finance lease.",
      },
      {
        standard: "IFRS 16",
        reference: "IFRS 16.81",
        kind: "requirement",
        requirement:
          "A lessor recognises lease payments from operating leases as income on a straight-line basis or another systematic basis.",
      },
      {
        standard: "ASC 842",
        reference: "842-30-25-1",
        kind: "requirement",
        requirement:
          "A lessor classifies a lease as a sales-type, direct financing, or operating lease and applies the corresponding recognition model.",
      },
    ],
    support: "partial",
    tier: "computation",
    limitation:
      "Lessor classification, straight-line levelling of escalating rents, and sales-type commencement (derecognition plus selling profit) are engine capabilities. The property-management tenant-billing pipeline does not yet post the levelling accrual automatically — rent invoices recognise as billed unless the levelled schedule from the lease module is applied. Direct-financing deferral of selling profit is not modelled separately from sales-type.",
    assertion:
      "A lessor tests each lease against the classification criteria; an operating lease's escalating rent levels to straight-line income with the accrual returning to exactly zero over the term; a sales-type lease derecognises the asset and takes selling profit at commencement.",
    facts: [
      "A five-year operating lease with rent rising from 10,000.00 to 14,000.00 a year, totalling 60,000.00.",
      "No transfer-of-risks criterion is met, so it classifies as operating.",
      "Straight-line income is 12,000.00 a year regardless of billing; year one accrues a 2,000.00 receivable.",
      "Separately, a sales-type lease with a net investment of 90,000.00 over a carrying amount of 75,000.00 recognises 15,000.00 of selling profit at commencement.",
    ],
    expected: {
      entries: [
        {
          step: "year 1 straight-line rent",
          lines: [
            { role: "ar", amount: "10000.0000" },
            { role: "contractAsset", amount: "2000.0000" },
            { role: "revenue", amount: "-12000.0000" },
          ],
        },
      ],
      values: {
        classification: "operating",
        straightLineAnnualIncome: "12000.0000",
        salesTypeSellingProfit: "15000.0000",
      },
    },
    run: (ctx) => {
      const { classification } = classifyLessorLease({
        leaseTermMonths: 60,
        economicLifeMonths: 480,
        pvOfPayments: "51000",
        fairValue: "400000",
      });
      const schedule = lessorStraightLineSchedule(["10000", "11000", "12000", "13000", "14000"]);
      const y1 = schedule[0]!;

      const salesType = salesTypeCommencement({
        netInvestment: "90000",
        carryingAmount: "75000",
        accounts: {
          netInvestmentAccountId: `probe:${randomUUID()}`,
          assetAccountId: `probe:${randomUUID()}`,
          sellingProfitAccountId: `probe:${randomUUID()}`,
        },
      });

      return {
        entries: [
          {
            step: "year 1 straight-line rent",
            lines: [
              { accountId: ctx.roles.ar, amount: y1.billed },
              { accountId: ctx.roles.contractAsset, amount: y1.accrualDelta },
              { accountId: ctx.roles.revenue, amount: neg(y1.income) },
            ],
          },
        ],
        values: {
          classification,
          straightLineAnnualIncome: y1.income,
          salesTypeSellingProfit: salesType.sellingProfit,
        },
      };
    },
  },
];

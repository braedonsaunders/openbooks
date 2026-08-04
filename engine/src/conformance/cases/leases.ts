/**
 * Leases — ASC 842 and IFRS 16.
 *
 * Every case in this file is a DECLARED GAP. The product has no lessee
 * accounting: there is no right-of-use asset, no lease liability, no discount
 * rate, and no lease classification test.
 *
 * What does exist is lessor-side property management — properties, units,
 * tenant leases, recurring rent charges, escalations and common-area
 * recoveries — which bills rent to tenants and recognises it as revenue. That
 * is a different requirement from the ones below and is not a partial
 * implementation of them.
 *
 * These cases are published rather than omitted so that the corpus states the
 * scope of the gap precisely, and so the target accounting is already encoded
 * for whoever implements the module.
 *
 * The worked figures below use a five-year lease with annual arrears payments
 * of 20,000.00 and a 5% discount rate. The present-value factor for a five-year
 * ordinary annuity at 5% is 4.3294766708, giving an opening liability of
 * 86,589.5334.
 */

import type { ConformanceCase } from "../types.ts";

const LESSEE_GAP =
  "There is no lessee lease accounting. No schema exists for lease contracts, " +
  "discount rates, lease terms, renewal or termination options, or payment " +
  "schedules; nothing computes a present value; and no right-of-use asset or " +
  "lease liability is ever recognised. Leases entered into as lessee are " +
  "accounted for only as the cash payments are made, which is the pre-ASC 842 " +
  "and pre-IFRS 16 treatment. Any entity with material leases must maintain " +
  "the lease schedule and the balance-sheet amounts outside the system and " +
  "post them by manual journal.";

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
    support: "not-implemented",
    tier: "computation",
    gap: LESSEE_GAP,
    assertion:
      "Entering into a lease puts both an asset and a liability on the balance sheet at commencement, so leased capacity and the obligation to pay for it are visible rather than off balance sheet.",
    facts: [
      "A five-year lease commencing 2026-01-01.",
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
    support: "not-implemented",
    tier: "computation",
    gap: LESSEE_GAP,
    assertion:
      "A finance lease produces a front-loaded total charge and puts the interest element into finance costs rather than operating expenses, which changes reported operating profit and every leverage and coverage ratio computed from it.",
    facts: [
      "Opening liability 86,589.5334 at 5%.",
      "Year one interest is 4,329.4767.",
      "The right-of-use asset amortises straight-line over five years at 17,317.9067 a year.",
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
    support: "not-implemented",
    tier: "computation",
    gap:
      LESSEE_GAP +
      " There is additionally no lease classification test, so the finance/operating distinction that drives the entire US GAAP presentation difference cannot be made.",
    assertion:
      "Under US GAAP an operating lease charges one flat amount to operating expenses each year, while still carrying the asset and liability on the balance sheet — a presentation that differs from IFRS for identical economics.",
    facts: [
      "The same five-year, 20,000.00-a-year lease at 5%.",
      "Total lease cost is 100,000.00 over five years, or 20,000.00 a year straight-line.",
      "Year one: the liability unwinds by 15,670.5233 after 4,329.4767 of imputed interest, and the right-of-use asset reduces by the same amount so the two stay aligned.",
      "No interest is presented separately; the whole 20,000.00 is one operating lease cost.",
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
      values: { annualStraightLineCost: "20000.0000" },
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
    support: "not-implemented",
    tier: "computation",
    gap:
      LESSEE_GAP +
      " A dual-reporting entity additionally needs the same lease to produce the IFRS single-model result and the US GAAP operating-lease result from one set of source data.",
    assertion:
      "The identical lease produces a different expense profile under IFRS than under US GAAP — front-loaded rather than flat — which is why a dual-reporting entity cannot use one set of numbers for both.",
    facts: [
      "The same five-year, 20,000.00-a-year lease at 5%.",
      "IFRS reports 4,329.4767 of interest plus 17,317.9067 of depreciation in year one, totalling 21,647.3834.",
      "US GAAP reports a flat 20,000.00 operating lease cost in the same year.",
      "The year-one difference between the two frameworks is 1,647.3834.",
    ],
    expected: {
      values: {
        ifrsYear1Charge: "21647.3834",
        usGaapOperatingYear1Charge: "20000.0000",
        frameworkDifference: "1647.3834",
      },
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
    support: "not-implemented",
    tier: "computation",
    gap:
      "Without lessee lease accounting there is nothing to exempt from. When the module is built, the election must be recorded per class of underlying asset, applied consistently, and disclosed — an election taken silently is itself an audit finding.",
    assertion:
      "An elected short-term lease charges rent straight-line to expense and recognises no asset or liability, and the election is recorded so it can be applied consistently and disclosed.",
    facts: [
      "A nine-month lease with no purchase option, at 1,000.00 a month.",
      "The short-term exemption is elected for this class of asset.",
      "Expense is 1,000.00 a month with no right-of-use asset and no lease liability.",
    ],
    expected: {
      entries: [
        {
          step: "monthly rent",
          lines: [
            { role: "leaseExpense", amount: "1000.0000" },
            { role: "bank", amount: "-1000.0000" },
          ],
        },
      ],
      values: { rouAssetRecognised: "0.0000", leaseLiabilityRecognised: "0.0000" },
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
    support: "not-implemented",
    tier: "ledger",
    gap:
      "The property-management module bills tenant rent and recognises it as revenue when charged, which resembles operating-lease lessor accounting but is not derived from a classification test. There is no assessment of whether a lease transfers substantially all the risks and rewards of ownership, no sales-type or direct-financing treatment, no net investment in the lease, and no straight-line levelling of escalating rents — an escalating lease is recognised as billed rather than levelled over the term.",
    assertion:
      "A lessor tests each lease against the classification criteria, recognises operating-lease rent evenly over the term regardless of the billing pattern, and derecognises the underlying asset for a sales-type lease.",
    facts: [
      "A five-year operating lease with rent rising from 10,000.00 to 14,000.00 a year, totalling 60,000.00.",
      "Straight-line income is 12,000.00 a year regardless of the amount billed.",
      "In year one the 2,000.00 billed short of the straight-line amount is accrued as a receivable.",
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
      values: { straightLineAnnualIncome: "12000.0000" },
    },
  },
];

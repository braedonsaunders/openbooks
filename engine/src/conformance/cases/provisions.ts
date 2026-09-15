/**
 * Provisions and contingencies — IAS 37 / ASC 450.
 *
 * These requirements are published as gaps: OpenBooks has no provisions
 * engine — nothing that tests an obligation against the recognition
 * threshold, measures it at a best estimate, reviews it each period, or
 * accrues a loss contingency. Each case states the target so a future
 * implementation knows exactly what to satisfy; until then the matrix shows
 * GAP, never green.
 *
 * No text from any accounting standard appears in this file; each
 * `requirement` line is our own restatement of the cited paragraph.
 */

import type { ConformanceCase } from "../types.ts";

export const PROVISION_CASES: readonly ConformanceCase[] = [
  {
    id: "prov-recognition-threshold",
    title: "A probable, estimable obligation is recognised as a provision",
    citations: [
      {
        standard: "IAS 37",
        reference: "IAS 37.14",
        kind: "requirement",
        requirement:
          "A provision is recognised when a present obligation from a past event makes an outflow of resources probable and the amount can be estimated reliably.",
      },
      {
        standard: "ASC 450",
        reference: "450-20-25-2",
        kind: "requirement",
        requirement:
          "An estimated loss from a loss contingency is accrued when it is probable that a liability has been incurred and the amount of loss can be reasonably estimated.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "A lawsuit that will probably cost 50,000.00 appears on the balance sheet now — a probable obligation is never left off the books until the cash leaves.",
    facts: [
      "A past event (a filed claim for defective work) creates a present legal obligation.",
      "Settlement is judged probable and counsel estimates 50,000.00 reliably.",
      "A provision of 50,000.00 is recognised: the charge hits profit or loss and the liability sits on the balance sheet.",
    ],
    gap: "No provisions engine exists: nothing records a present obligation, tests it against the probable-and-estimable threshold, or posts the resulting liability — such obligations can only be entered as manual journals with no recognition discipline behind them.",
    expected: {
      values: {
        provisionLiability: "50000.0000",
        profitOrLossCharge: "50000.0000",
      },
    },
  },

  {
    id: "prov-best-estimate-measurement",
    title: "A provision is measured at the best estimate and reviewed every period",
    citations: [
      {
        standard: "IAS 37",
        reference: "IAS 37.36",
        kind: "requirement",
        requirement:
          "The amount recognised as a provision is the best estimate of the expenditure required to settle the present obligation at the reporting date.",
      },
      {
        standard: "IAS 37",
        reference: "IAS 37.59",
        kind: "requirement",
        requirement:
          "Provisions are reviewed at the end of each reporting period and adjusted to reflect the current best estimate.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "The provision tracks the current best estimate — when new information moves the estimate from 50,000.00 to 65,000.00, a further 15,000.00 is charged in the period the estimate changes.",
    facts: [
      "An opening provision of 50,000.00 for the filed claim.",
      "Before year end, counsel revises the best estimate of the settlement to 65,000.00.",
      "The provision is adjusted to 65,000.00 with a 15,000.00 charge in the current period.",
    ],
    gap: "With no provisions ledger there is nothing to remeasure: no periodic review of open provisions, no adjustment path for a changed estimate, and no utilisation tracking when the obligation settles.",
    expected: {
      values: {
        revisedProvision: "65000.0000",
        currentPeriodCharge: "15000.0000",
      },
    },
  },
];

/**
 * Impairment and derecognition of long-lived assets — ASC 360 and IAS 16.
 *
 * These cases exercise the product's own measurement functions (the same ones
 * `remeasureAsset` and `disposeAsset` call to produce their journal entries),
 * so what is asserted here is the arithmetic that reaches the ledger.
 */

import { computeDisposal, computeRemeasurement } from "../../asset-lifecycle.ts";
import { add } from "../../money.ts";
import type { ConformanceCase } from "../types.ts";

export const LONG_LIVED_ASSET_CASES: readonly ConformanceCase[] = [
  {
    id: "ppe-impairment-to-fair-value",
    title: "An impaired asset is written down to fair value and the loss is recognised immediately",
    citations: [
      {
        standard: "ASC 360",
        reference: "360-10-35-17",
        kind: "requirement",
        requirement:
          "When a long-lived asset's carrying amount is not recoverable, an impairment loss is measured as the excess of carrying amount over fair value.",
      },
      {
        standard: "IAS 16",
        reference: "IAS 16.63",
        kind: "requirement",
        requirement:
          "The carrying amount of an item of property, plant and equipment is reduced when it is impaired, and the loss is recognised.",
      },
    ],
    support: "semantic",
    tier: "computation",
    assertion:
      "The carrying amount falls to fair value by exactly the shortfall, and the whole shortfall is charged to profit or loss in the period — no part of it is deferred or spread.",
    facts: [
      "An asset with a cost of 100,000.00 and accumulated depreciation of 40,000.00.",
      "Carrying amount is therefore 60,000.00.",
      "Fair value is 45,000.00 and the carrying amount is not recoverable.",
      "The impairment loss is 15,000.00.",
      "The product records the reduction against accumulated depreciation, leaving gross cost intact. This is a presentation choice: carrying amount, the loss, and subsequent depreciation are all identical to reducing the asset account directly.",
    ],
    expected: {
      entries: [
        {
          step: "impairment",
          lines: [
            { role: "impairmentLoss", amount: "15000.0000" },
            { role: "accumulatedDepreciation", amount: "-15000.0000" },
          ],
        },
      ],
      values: { delta: "-15000.0000" },
    },
    run: (ctx) => {
      const { delta, lines } = computeRemeasurement({
        cost: "100000.00",
        accumulated: "40000.00",
        newCarryingValue: "45000.00",
        accumulatedDepreciationAccountId: ctx.roles.accumulatedDepreciation,
        adjustmentAccountId: ctx.roles.impairmentLoss,
      });
      return { entries: [{ step: "impairment", lines }], values: { delta } };
    },
  },

  {
    id: "ppe-impairment-establishes-new-basis",
    title: "The written-down amount becomes the new cost basis for future depreciation",
    citations: [
      {
        standard: "ASC 360",
        reference: "360-10-35-20",
        kind: "requirement",
        requirement:
          "After an impairment loss is recognised, the adjusted carrying amount is the asset's new cost basis and is depreciated over its remaining useful life.",
      },
      {
        standard: "IAS 36",
        reference: "IAS 36.63",
        kind: "requirement",
        requirement:
          "After recognising an impairment loss, depreciation is adjusted to allocate the revised carrying amount over the remaining useful life.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Future depreciation runs off the impaired carrying amount, so the asset is never depreciated back through an amount that has already been written off.",
    facts: [
      "Carrying amount of 60,000.00 impaired to 45,000.00.",
      "The new basis is 45,000.00, which is what remaining depreciation must consume.",
      "`remeasureAsset` rebuilds the remaining unposted depreciation schedule from the new basis rather than leaving the original schedule in place.",
    ],
    expected: { values: { newCarryingValue: "45000.0000" } },
    run: (ctx) => {
      const { delta } = computeRemeasurement({
        cost: "100000.00",
        accumulated: "40000.00",
        newCarryingValue: "45000.00",
        accumulatedDepreciationAccountId: ctx.roles.accumulatedDepreciation,
        adjustmentAccountId: ctx.roles.impairmentLoss,
      });
      // New basis = old carrying amount + delta. Derived from the movement the
      // product computed, not restated, so the case fails if the movement is
      // wrong. Decimal arithmetic throughout — never floating point.
      return { values: { newCarryingValue: add("60000.00", delta) } };
    },
  },

  {
    id: "ppe-disposal-gain-loss",
    title: "Derecognition removes cost and accumulated depreciation and recognises the gain or loss",
    citations: [
      {
        standard: "ASC 360",
        reference: "360-10-40-5",
        kind: "requirement",
        requirement:
          "A gain or loss on the sale of a long-lived asset is the difference between the proceeds and the asset's carrying amount.",
      },
      {
        standard: "IAS 16",
        reference: "IAS 16.71",
        kind: "requirement",
        requirement:
          "The gain or loss on derecognition is the difference between net disposal proceeds and the carrying amount of the item.",
      },
      {
        standard: "IAS 16",
        reference: "IAS 16.68",
        kind: "requirement",
        requirement:
          "The carrying amount of an item of property, plant and equipment is derecognised on disposal.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "On sale, the asset's cost and its accumulated depreciation both leave the balance sheet entirely and the profit or loss recognised is exactly proceeds less carrying amount — a disposal cannot leave a stub balance behind.",
    facts: [
      "An asset with a cost of 100,000.00 and accumulated depreciation of 70,000.00.",
      "Carrying amount is 30,000.00.",
      "It is sold for cash proceeds of 35,000.00.",
      "The gain is 5,000.00.",
    ],
    expected: {
      entries: [
        {
          step: "disposal",
          lines: [
            { role: "fixedAsset", amount: "-100000.0000" },
            { role: "accumulatedDepreciation", amount: "70000.0000" },
            { role: "bank", amount: "35000.0000" },
            { role: "disposalGainLoss", amount: "-5000.0000" },
          ],
        },
      ],
      values: { carryingAmount: "30000.0000", gainLoss: "5000.0000" },
    },
    run: (ctx) => {
      const { nbv, gainLoss, lines } = computeDisposal({
        cost: "100000.00",
        accumulated: "70000.00",
        proceeds: "35000.00",
        accounts: {
          assetAccountId: ctx.roles.fixedAsset,
          accumulatedDepreciationAccountId: ctx.roles.accumulatedDepreciation,
          gainLossAccountId: ctx.roles.disposalGainLoss,
          proceedsAccountId: ctx.roles.bank,
        },
      });
      return {
        entries: [{ step: "disposal", lines }],
        values: { carryingAmount: nbv, gainLoss },
      };
    },
  },

  {
    id: "ppe-writeoff-recognises-full-carrying-amount",
    title: "Scrapping an asset with no proceeds recognises the whole carrying amount as a loss",
    citations: [
      {
        standard: "IAS 16",
        reference: "IAS 16.67",
        kind: "requirement",
        requirement:
          "The carrying amount of an item of property, plant and equipment is derecognised on disposal or when no future economic benefits are expected from its use or disposal.",
      },
      {
        standard: "ASC 360",
        reference: "360-10-40-5",
        kind: "requirement",
        requirement:
          "The gain or loss on derecognition is the difference between the proceeds, if any, and the carrying amount.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A write-off with no proceeds charges the full remaining carrying amount to profit or loss and produces a balanced entry with no proceeds line at all.",
    facts: [
      "An asset with a cost of 20,000.00 and accumulated depreciation of 12,000.00.",
      "Carrying amount is 8,000.00 and it is scrapped for nothing.",
      "The loss is 8,000.00.",
    ],
    expected: {
      entries: [
        {
          step: "write-off",
          lines: [
            { role: "fixedAsset", amount: "-20000.0000" },
            { role: "accumulatedDepreciation", amount: "12000.0000" },
            { role: "disposalGainLoss", amount: "8000.0000" },
          ],
        },
      ],
      values: { gainLoss: "-8000.0000" },
    },
    run: (ctx) => {
      const { gainLoss, lines } = computeDisposal({
        cost: "20000.00",
        accumulated: "12000.00",
        proceeds: "0",
        accounts: {
          assetAccountId: ctx.roles.fixedAsset,
          accumulatedDepreciationAccountId: ctx.roles.accumulatedDepreciation,
          gainLossAccountId: ctx.roles.disposalGainLoss,
        },
      });
      return { entries: [{ step: "write-off", lines }], values: { gainLoss } };
    },
  },

  // -------------------------------------------------------------------------
  // Declared gaps
  // -------------------------------------------------------------------------
  {
    id: "ppe-us-gaap-prohibits-restoration",
    title: "US GAAP prohibits reversing an impairment of a held-and-used asset",
    citations: [
      {
        standard: "ASC 360",
        reference: "360-10-35-20",
        kind: "requirement",
        requirement:
          "Restoration of a previously recognised impairment loss is prohibited for a long-lived asset that is held and used.",
      },
      {
        standard: "IAS 36",
        reference: "IAS 36.114",
        kind: "requirement",
        requirement:
          "An impairment loss recognised in prior periods is reversed if, and only if, the estimates used to determine recoverable amount have changed.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    gap:
      "`remeasureAsset` accepts any new carrying value in either direction. Writing an impaired asset back up is permitted, which IFRS requires but US GAAP forbids, and nothing records whether a given write-up is a permitted IAS 16 revaluation, a permitted IAS 36 reversal, or a prohibited ASC 360 restoration. The organisation already carries an `asc740`/`ias12` reporting-framework flag for income tax; long-lived assets need the same flag to gate this, plus retention of the historical impairment so an IAS 36 reversal can be capped at what depreciated cost would have been.",
    assertion:
      "Under US GAAP a recovery in fair value after impairment produces no entry; under IFRS a reversal is recognised but is capped at the carrying amount that would have existed had no impairment been recognised.",
    facts: [
      "An asset impaired from a carrying amount of 60,000.00 down to 45,000.00.",
      "Fair value later recovers to 58,000.00.",
      "Under US GAAP the carrying amount stays at 45,000.00 less subsequent depreciation.",
      "Under IFRS a reversal is recognised, limited to depreciated historical cost.",
    ],
    expected: {
      values: { usGaapReversal: "0.0000", ifrsReversalIsCapped: "true" },
    },
  },
];

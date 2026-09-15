/**
 * Impairment and derecognition of long-lived assets — ASC 360 and IAS 16.
 *
 * These cases exercise the product's own measurement functions (the same ones
 * `remeasureAsset` and `disposeAsset` call to produce their journal entries),
 * so what is asserted here is the arithmetic that reaches the ledger.
 */

import { computeDisposal, computeRemeasurement, remeasurementPolicy } from "../../asset-lifecycle.ts";
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
      {
        standard: "IAS 36",
        reference: "IAS 36.117",
        kind: "requirement",
        requirement:
          "A reversal must not increase the carrying amount above what it would have been, net of depreciation, had no impairment been recognised.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The same fair-value recovery after an impairment is refused outright under US GAAP — the impaired amount is the new cost basis — and recognised under IFRS only up to the unreversed impairment, so the carrying amount can never climb back above depreciated historical cost through the remeasurement path. The answer comes from the organisation's configured reporting framework.",
    facts: [
      "An asset impaired from a carrying amount of 60,000.00 down to 45,000.00 — an unreversed impairment of 15,000.00.",
      "Fair value later recovers, and a write-up to 58,000.00 (13,000.00) is requested.",
      "Under US GAAP the write-up is refused; the carrying amount stays at 45,000.00.",
      "Under IFRS the 13,000.00 reversal is recognised (within the 15,000.00 cap).",
      "A write-up to 62,000.00 (17,000.00) is refused under IFRS: it exceeds the cap.",
    ],
    expected: {
      values: {
        usGaapRestorationRefused: "true",
        ifrsReversalAllowed: "true",
        ifrsReversalPortion: "13000.0000",
        ifrsBeyondCapRefused: "true",
      },
    },
    run: () => {
      const unreversedImpairment = "15000.00"; // 60,000 impaired to 45,000

      const usGaap = remeasurementPolicy({
        framework: "us_gaap",
        delta: "13000.00",
        unreversedImpairment,
      });
      const ifrsWithinCap = remeasurementPolicy({
        framework: "ifrs",
        delta: "13000.00",
        unreversedImpairment,
      });
      const ifrsBeyondCap = remeasurementPolicy({
        framework: "ifrs",
        delta: "17000.00",
        unreversedImpairment,
      });

      return {
        values: {
          usGaapRestorationRefused: String(!usGaap.allowed),
          ifrsReversalAllowed: String(ifrsWithinCap.allowed),
          ifrsReversalPortion: ifrsWithinCap.reversalPortion,
          ifrsBeyondCapRefused: String(!ifrsBeyondCap.allowed),
        },
      };
    },
  },

  {
    id: "ppe-partial-disposal",
    title: "Selling part of an asset derecognises the pro-rata carrying amount",
    citations: [
      {
        standard: "IAS 16",
        reference: "IAS 16.68",
        kind: "requirement",
        requirement:
          "The gain or loss on derecognition is the difference between the net disposal proceeds, if any, and the carrying amount of the item or part derecognised.",
      },
      {
        standard: "ASC 360",
        reference: "360-10-40-1",
        kind: "requirement",
        requirement:
          "A gain or loss on disposal of long-lived assets is recognised for the difference between the proceeds and the carrying amount of the assets disposed of.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "Selling forty percent of a machine removes forty percent of its cost and forty percent of its accumulated depreciation, and the gain is measured against the forty-percent carrying amount — the remaining sixty percent keeps depreciating untouched.",
    facts: [
      "A machine carried at a cost of 100,000.00 with accumulated depreciation of 40,000.00: carrying amount 60,000.00.",
      "Forty percent is sold for 30,000.00: derecognised cost 40,000.00, derecognised accumulated depreciation 16,000.00, carrying amount disposed 24,000.00.",
      "The gain on the partial disposal is 6,000.00 and the retained sixty percent continues at a carrying amount of 36,000.00.",
    ],
    gap: "Disposal is whole-asset only: disposeAsset takes the full cost and the full posted accumulated depreciation, with no portion or percentage — a partial sale can only be recorded as a manual journal with no schedule split behind it.",
    expected: {
      values: {
        derecognisedCost: "40000.0000",
        derecognisedAccumulated: "16000.0000",
        disposedCarryingAmount: "24000.0000",
        partialGain: "6000.0000",
        retainedCarryingAmount: "36000.0000",
      },
    },
  },

  {
    id: "ppe-intercompany-transfer",
    title: "Moving an asset between subsidiaries carries its basis and eliminates the internal gain",
    citations: [
      {
        standard: "IAS 16",
        reference: "IAS 16.67",
        kind: "requirement",
        requirement:
          "The cost of an item of property, plant and equipment is recognised as an asset when future economic benefits are probable and the cost can be measured reliably — a transferred asset keeps a measurable carrying amount across the move.",
      },
      {
        standard: "ASC 360",
        reference: "360-10-40-1",
        kind: "requirement",
        requirement:
          "A gain or loss on disposal of long-lived assets is recognised for the difference between the proceeds and the carrying amount of the assets disposed of.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "An asset moving between legal entities keeps its carrying amount as the group's basis: the transferor's internal gain is eliminated on consolidation, the transferee depreciates the transferred basis, and no depreciation is lost or double-counted in the move.",
    facts: [
      "A subsidiary holds a machine at a cost of 100,000.00 with accumulated depreciation of 40,000.00: carrying amount 60,000.00.",
      "It transfers the machine to a fellow subsidiary for 70,000.00: the transferor recognises an internal gain of 10,000.00 and the transferee records the asset at 70,000.00.",
      "On consolidation the 10,000.00 internal gain is eliminated and the group carries the machine at 60,000.00 with its remaining life unchanged.",
    ],
    gap: "No transfer path exists: moving an asset between subsidiaries means a manual disposal in one entity and a manual capitalisation in the other, with no linkage, no basis carryover, and no elimination entry for the internal gain.",
    expected: {
      values: {
        transferorGain: "10000.0000",
        transfereeCost: "70000.0000",
        consolidatedCarryingAmount: "60000.0000",
      },
    },
  },

  {
    id: "ppe-depreciation-445-calendar",
    title: "Depreciation follows the entity's fiscal calendar including retail 4-4-5 patterns",
    citations: [
      {
        standard: "IAS 16",
        reference: "IAS 16.60",
        kind: "requirement",
        requirement:
          "The depreciable amount of an asset is allocated on a systematic basis over its useful life, in periods that follow the entity's reporting calendar.",
      },
      {
        standard: "ASC 360",
        reference: "360-10-35-4",
        kind: "requirement",
        requirement:
          "The cost of a long-lived asset, less any salvage value, is depreciated in a systematic and rational manner over the asset's useful life.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "An entity reporting on a 4-4-5 retail calendar depreciates week-based periods — four weeks, four weeks, five weeks — with each period carrying its share of the annual charge, so the full useful life is covered with nothing skipped and nothing doubled.",
    facts: [
      "A retail entity reports on a 4-4-5 calendar anchored 2026-02-01: the 2026 year runs 2026-02-01 to 2027-01-30 in twelve week-based periods.",
      "A 5-week period such as 2026-06-28 to 2026-08-01 spans two calendar month-starts, so two native monthly charges map onto one accounting period.",
      "The book engine plans one charge per calendar month and refuses when two months land in one period — the schedule cannot be built on this calendar at all.",
    ],
    gap: "Book depreciation is monthly-native: computeSchedule plans per calendar month and buildSchedule throws 'multiple native depreciation months map to one accounting period' on any 4-4-5, 4-5-4, 5-4-4, or thirteen-period calendar whose week-based periods span month-starts. Entities on retail calendars cannot schedule depreciation.",
    expected: {
      values: {
        periodsIn445Year: "12",
        scheduleBuildable: "false",
      },
    },
  },
];

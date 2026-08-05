/**
 * Income taxes — ASC 740 and IAS 12.
 *
 * These cases drive `buildProvision`, which is the product's actual provision
 * engine: `computeProvisionRun` gathers pretax income, enacted rates and
 * temporary differences from the ledger and hands them to this function, and
 * `postProvisionRun` books what it returns. Asserting on it asserts on what
 * reaches the financial statements.
 */

import { buildProvision, deferredAssetAdjustmentLabel } from "../../income-tax-provision.ts";
import type { ConformanceCase } from "../types.ts";

export const INCOME_TAX_CASES: readonly ConformanceCase[] = [
  {
    id: "tax-total-expense-is-current-plus-deferred",
    title: "Total income tax expense is current tax plus deferred tax",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-10-1",
        kind: "requirement",
        requirement:
          "The objectives of accounting for income taxes are to recognise the tax payable or refundable for the current year and the deferred tax consequences of events already recognised.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.58",
        kind: "requirement",
        requirement:
          "Current and deferred tax are recognised as income or expense and included in profit or loss for the period.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The tax charge in profit or loss is the sum of the current-year liability and the movement in deferred taxes — the two components are computed separately and neither is dropped.",
    facts: [
      "Pretax book income of 1,000,000.00.",
      "A non-deductible permanent difference of 50,000.00.",
      "A taxable temporary difference of 200,000.00 originating this year on fixed assets, giving a deferred tax liability.",
      "The enacted rate is 25%.",
      "Taxable profit is 1,000,000 + 50,000 − 200,000 = 850,000.00; current tax is 212,500.00.",
      "The deferred tax liability of 200,000 at 25% is 50,000.00, all of it arising this year.",
      "Total tax expense is 262,500.00 — the timing difference shifts tax between current and deferred without changing the total.",
    ],
    expected: {
      values: {
        taxableIncome: "850000.0000",
        currentTax: "212500.0000",
        deferredExpense: "50000.0000",
        totalExpense: "262500.0000",
        deferredTaxLiability: "50000.0000",
      },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "1000000.00",
        enactedRatePercent: "25",
        permanentDifferences: [{ description: "Non-deductible expenses", amount: "50000.00" }],
        lossCarryforwardUsed: "0",
        valuationAllowance: "0",
        differences: [
          {
            category: "fixed_assets",
            description: "Accelerated tax depreciation",
            difference: "200000.00",
            source: "manual",
          },
        ],
      });
      return {
        values: {
          taxableIncome: provision.taxableIncome,
          currentTax: provision.currentTax,
          deferredExpense: provision.deferredExpense,
          totalExpense: provision.totalExpense,
          deferredTaxLiability: provision.balances.dtlGross,
        },
      };
    },
  },

  {
    id: "tax-deferred-measured-at-enacted-rate",
    title: "Deferred tax is measured at the enacted rate expected to apply on reversal",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-30-5",
        kind: "requirement",
        requirement:
          "Deferred tax is measured using enacted tax rates expected to apply to taxable income in the years the temporary difference is expected to reverse.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.47",
        kind: "requirement",
        requirement:
          "Deferred tax is measured at the tax rates expected to apply when the asset is realised or the liability settled, based on rates enacted or substantively enacted by the end of the reporting period.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Deferred balances move with the enacted rate: the same temporary difference measured at a different enacted rate produces a proportionally different deferred balance, so a rate change is reflected rather than ignored.",
    facts: [
      "A taxable temporary difference of 400,000.00.",
      "At an enacted rate of 25% the deferred tax liability is 100,000.00.",
      "At an enacted rate of 21% the same difference gives 84,000.00.",
    ],
    expected: {
      values: { dtlAt25: "100000.0000", dtlAt21: "84000.0000" },
    },
    run: () => {
      const at = (rate: string): string =>
        buildProvision({
          pretaxBookIncome: "0",
          enactedRatePercent: rate,
          permanentDifferences: [],
          lossCarryforwardUsed: "0",
          valuationAllowance: "0",
          differences: [
            {
              category: "fixed_assets",
              description: "Accelerated tax depreciation",
              difference: "400000.00",
              source: "manual",
            },
          ],
        }).balances.dtlGross;
      return { values: { dtlAt25: at("25"), dtlAt21: at("21") } };
    },
  },

  {
    id: "tax-deductible-difference-creates-deferred-asset",
    title: "A deductible temporary difference creates a deferred tax asset",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-25-2",
        kind: "requirement",
        requirement:
          "A deferred tax asset is recognised for deductible temporary differences and carryforwards.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.24",
        kind: "requirement",
        requirement:
          "A deferred tax asset is recognised for all deductible temporary differences to the extent that taxable profit will be available against which they can be utilised.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Deductible and taxable differences are separated rather than netted into one figure, so the gross deferred tax asset and gross deferred tax liability are both visible — the presentation an auditor tests against the tax footnote.",
    facts: [
      "A deductible temporary difference of 120,000.00 on provisions.",
      "A taxable temporary difference of 300,000.00 on fixed assets.",
      "At 25%, the gross deferred tax asset is 30,000.00 and the gross deferred tax liability is 75,000.00.",
    ],
    expected: {
      values: { deferredTaxAsset: "30000.0000", deferredTaxLiability: "75000.0000" },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "0",
        enactedRatePercent: "25",
        permanentDifferences: [],
        lossCarryforwardUsed: "0",
        valuationAllowance: "0",
        differences: [
          {
            category: "provisions",
            description: "Accrued warranty provision",
            difference: "-120000.00",
            source: "manual",
          },
          {
            category: "fixed_assets",
            description: "Accelerated tax depreciation",
            difference: "300000.00",
            source: "manual",
          },
        ],
      });
      return {
        values: {
          deferredTaxAsset: provision.balances.dtaGross,
          deferredTaxLiability: provision.balances.dtlGross,
        },
      };
    },
  },

  {
    id: "tax-valuation-allowance-reduces-deferred-asset",
    title: "A deferred tax asset is reduced when realisation is not expected",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-30-5(e)",
        kind: "requirement",
        requirement:
          "A valuation allowance reduces deferred tax assets to the amount that is more likely than not to be realised.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.56",
        kind: "requirement",
        requirement:
          "The carrying amount of a deferred tax asset is reduced to the extent it is no longer probable that sufficient taxable profit will be available.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Unrealisable deferred tax assets raise the tax charge in the period the judgement is made, and the allowance can never exceed the gross asset it reduces.",
    facts: [
      "A deductible temporary difference of 400,000.00 at 25% gives a gross deferred tax asset of 100,000.00.",
      "Only 60,000.00 is expected to be realised, so an allowance of 40,000.00 is recognised.",
      "The allowance increases deferred tax expense by 40,000.00.",
    ],
    expected: {
      values: {
        deferredTaxAsset: "100000.0000",
        valuationAllowance: "40000.0000",
        deferredExpense: "-60000.0000",
      },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "0",
        enactedRatePercent: "25",
        permanentDifferences: [],
        lossCarryforwardUsed: "0",
        valuationAllowance: "40000.00",
        differences: [
          {
            category: "loss_carryforward",
            description: "Loss carryforward",
            difference: "-400000.00",
            source: "manual",
          },
        ],
      });
      return {
        values: {
          deferredTaxAsset: provision.balances.dtaGross,
          valuationAllowance: provision.balances.valuationAllowance,
          deferredExpense: provision.deferredExpense,
        },
      };
    },
  },

  {
    id: "tax-allowance-cannot-exceed-gross-asset",
    title: "A valuation allowance greater than the deferred tax asset is rejected",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-30-5(e)",
        kind: "requirement",
        requirement:
          "A valuation allowance reduces deferred tax assets to the amount more likely than not to be realised; it cannot reduce them below zero.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The provision refuses to produce a negative deferred tax asset, so a mis-keyed allowance is rejected at entry rather than becoming a nonsensical balance in the tax footnote.",
    facts: [
      "A gross deferred tax asset of 25,000.00.",
      "An allowance of 40,000.00 is entered against it.",
      "The computation must be rejected.",
    ],
    expected: { values: { rejected: "true" } },
    run: () => {
      try {
        buildProvision({
          pretaxBookIncome: "0",
          enactedRatePercent: "25",
          permanentDifferences: [],
          lossCarryforwardUsed: "0",
          valuationAllowance: "40000.00",
          differences: [
            {
              category: "provisions",
              description: "Accrued provision",
              difference: "-100000.00",
              source: "manual",
            },
          ],
        });
        return { values: { rejected: "false" } };
      } catch {
        return { values: { rejected: "true" } };
      }
    },
  },

  {
    id: "tax-permanent-difference-changes-effective-rate",
    title: "Permanent differences move the effective rate away from the statutory rate",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-50-12",
        kind: "requirement",
        requirement:
          "A public entity reconciles the reported income tax expense to the amount produced by applying the statutory rate to pretax income.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.81(c)",
        kind: "requirement",
        requirement:
          "An entity discloses a reconciliation between tax expense and the product of accounting profit multiplied by the applicable tax rate.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The rate reconciliation begins at the statutory charge, shows each reconciling item separately, and ends at the reported total — the schedule that supports the effective tax rate disclosure.",
    facts: [
      "Pretax book income of 500,000.00 at a statutory rate of 25% gives an expected charge of 125,000.00.",
      "Non-deductible entertaining of 20,000.00 adds 5,000.00.",
      "Reported tax expense is 130,000.00 and the effective rate is 26%.",
    ],
    expected: {
      values: {
        statutoryCharge: "125000.0000",
        permanentEffect: "5000.0000",
        totalExpense: "130000.0000",
        effectiveRatePercent: "26.00",
        reconciliationEndsAtTotal: "true",
      },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "500000.00",
        enactedRatePercent: "25",
        permanentDifferences: [{ description: "Non-deductible entertaining", amount: "20000.00" }],
        lossCarryforwardUsed: "0",
        valuationAllowance: "0",
        differences: [],
      });
      const steps = provision.rateReconciliation;
      const last = steps[steps.length - 1]!;
      return {
        values: {
          statutoryCharge: steps.find((s) => s.key === "statutory")!.amount,
          permanentEffect: steps.find((s) => s.key.startsWith("permanent:"))!.amount,
          totalExpense: provision.totalExpense,
          effectiveRatePercent: provision.effectiveRatePercent ?? "(none)",
          reconciliationEndsAtTotal: String(last.key === "total" && last.amount === provision.totalExpense),
        },
      };
    },
  },

  {
    id: "tax-framework-terminology",
    title: "The reduction in a deferred tax asset is labelled per the reporting framework",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-30-5(e)",
        kind: "requirement",
        requirement:
          "US GAAP reduces deferred tax assets through a separately identified valuation allowance.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.24",
        kind: "requirement",
        requirement:
          "IFRS recognises a deferred tax asset only to the extent of probable future taxable profit, rather than recognising it gross and then allowing against it.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "The same arithmetic is presented in the vocabulary of whichever framework the entity reports under, so an IFRS filer never sees a US GAAP-only term in its tax note.",
    facts: [
      "A US GAAP reporter calls the reduction a valuation allowance.",
      "An IFRS reporter describes it as a deferred tax asset recognition adjustment.",
    ],
    expected: {
      values: {
        asc740Label: "Valuation allowance",
        ias12Label: "Deferred tax asset recognition adjustment",
      },
    },
    run: () => ({
      values: {
        asc740Label: deferredAssetAdjustmentLabel("asc740"),
        ias12Label: deferredAssetAdjustmentLabel("ias12"),
      },
    }),
  },

  {
    id: "tax-current-tax-omits-temporary-differences",
    // The id records this register entry's history: it began life as a partial
    // whose limitation was exactly this omission. Ids are stable; the title and
    // status carry the current truth.
    title: "Current tax is measured on taxable profit for the period",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-30-2",
        kind: "requirement",
        requirement:
          "Current tax expense or benefit is measured as the amount of taxes payable or refundable for the year, determined from taxable income for that year.",
      },
      {
        standard: "IAS 12",
        reference: "IAS 12.12",
        kind: "requirement",
        requirement:
          "Current tax for the period is recognised as a liability to the extent unpaid, measured on taxable profit for that period.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Taxable profit reflects permanent differences, utilised loss carryforwards, AND the year's originating movement in temporary differences — so income tax payable is the amount actually owed on the return, and the current/deferred split is right whenever timing differences exist.",
    facts: [
      "Pretax book income of 800,000.00.",
      "A non-deductible permanent difference of 30,000.00.",
      "A loss carryforward of 100,000.00 is utilised.",
      "A taxable temporary difference of 40,000.00 originates this year (tax depreciation ahead of book).",
      "Taxable profit is 800,000 + 30,000 − 100,000 − 40,000 = 690,000.00; current tax at 25% is 172,500.00.",
      "The 40,000.00 difference gives a deferred tax liability of 10,000.00; total tax expense is 182,500.00.",
    ],
    expected: {
      values: {
        taxableIncome: "690000.0000",
        currentTax: "172500.0000",
        deferredExpense: "10000.0000",
        totalExpense: "182500.0000",
      },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "800000.00",
        enactedRatePercent: "25",
        permanentDifferences: [{ description: "Non-deductible expenses", amount: "30000.00" }],
        lossCarryforwardUsed: "100000.00",
        valuationAllowance: "0",
        differences: [
          {
            category: "fixed_assets",
            description: "Accelerated tax depreciation",
            difference: "40000.00",
            source: "manual",
          },
        ],
      });
      return {
        values: {
          taxableIncome: provision.taxableIncome,
          currentTax: provision.currentTax,
          deferredExpense: provision.deferredExpense,
          totalExpense: provision.totalExpense,
        },
      };
    },
  },

  {
    id: "tax-loss-does-not-create-negative-current-tax",
    title: "A taxable loss does not produce a negative current tax charge",
    citations: [
      {
        standard: "ASC 740",
        reference: "740-10-25-2",
        kind: "requirement",
        requirement:
          "The benefit of a loss is recognised through a deferred tax asset for the carryforward, not as a negative current tax payable, unless it is refundable by carryback.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A loss-making year reports no current tax rather than a negative payable, and the reconciliation discloses the unrecognised current benefit explicitly instead of burying it.",
    facts: [
      "A pretax book loss of 200,000.00 with no permanent differences.",
      "Current tax is nil, not a 50,000.00 receivable.",
      "The reconciliation shows the current-year loss carrying no current tax.",
    ],
    expected: {
      values: {
        taxableIncome: "-200000.0000",
        currentTax: "0.0000",
        disclosesUnrecognisedBenefit: "true",
      },
    },
    run: () => {
      const provision = buildProvision({
        pretaxBookIncome: "-200000.00",
        enactedRatePercent: "25",
        permanentDifferences: [],
        lossCarryforwardUsed: "0",
        valuationAllowance: "0",
        differences: [],
      });
      return {
        values: {
          taxableIncome: provision.taxableIncome,
          currentTax: provision.currentTax,
          disclosesUnrecognisedBenefit: String(
            provision.rateReconciliation.some((s) => s.key === "currentLossNotRecognized"),
          ),
        },
      };
    },
  },
];

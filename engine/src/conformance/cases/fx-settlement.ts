/**
 * Foreign-currency settlement and non-monetary items — IAS 21.28 / IAS 21.23(b)
 * (and the equivalent US GAAP requirements in ASC 830-20, cited as the
 * operative second source).
 *
 * The retranslation corpus in foreign-currency.ts proves the period-end
 * UNREALIZED side. These cases prove the other two FX requirements: the
 * REALIZED difference recognised when a monetary item settles during the
 * period, and the rule that non-monetary items measured at historical cost
 * are never retranslated.
 *
 * Settlement cases drive the payment engine's own settlement arithmetic
 * (`carryingAmountForSettlement` + `realizedFxControlAdjustment`): the
 * consumed carrying value and the gain/loss plug the payment posts. A case
 * that recomputed the answer itself would prove nothing.
 */

import { carryingAmountForSettlement, realizedFxControlAdjustment } from "../../payments/payments.ts";
import { runRevaluation } from "../../close/fx-revaluation.ts";
import { capture, periodFor, postNewDocument, setSpotRate } from "../ledger-helpers.ts";
import { db } from "../../platform/db.ts";
import { sql } from "drizzle-orm";
import type { ConformanceCase } from "../types.ts";

export const FX_SETTLEMENT_CASES: readonly ConformanceCase[] = [
  {
    id: "fx-settlement-realized-gain",
    title: "Settling a monetary item recognises the realized difference in profit or loss",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.28",
        kind: "requirement",
        requirement:
          "Exchange differences arising on settling monetary items are recognised in profit or loss in the period in which they arise.",
      },
      {
        standard: "ASC 830",
        reference: "ASC 830-20-35-1",
        kind: "requirement",
        requirement:
          "A change in exchange rates between the transaction date and the settlement date increases or decreases the functional-currency cash flow, and that increase or decrease is a transaction gain or loss recognised in income.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Collecting part of a foreign-currency receivable clears exactly the proportional share of its carrying value, values the cash at the settlement-date rate, and books the difference as a realized gain or loss — the settled slice never leaves a tail behind and the unsettled slice keeps its historical carrying value.",
    facts: [
      "A USD receivable of 1,000.00 carried at CAD 1,350.00 (booked at 1.3500).",
      "USD 600.00 is collected when the spot rate is 1.4000: cash of CAD 840.00.",
      "The consumed carrying value is 1,350.00 × 600/1,000 = CAD 810.00, leaving CAD 540.00 on the receivable for the remaining USD 400.00.",
      "Cash exceeds consumed carrying value by CAD 30.00 — a realized gain, credited to the realized exchange gain/loss account.",
    ],
    expected: {
      entries: [
        {
          step: "partial settlement at 1.40",
          lines: [
            { role: "ar", amount: "-810.0000" },
            { role: "bank", amount: "840.0000" },
            { role: "fxRealizedGainLoss", amount: "-30.0000" },
          ],
        },
      ],
    },
    run: (ctx) => {
      const consumed = carryingAmountForSettlement("1350.00", "1000.00", "600.00");
      const cash = "840.00";
      const adjustment = realizedFxControlAdjustment(`-${consumed}`, cash);
      return {
        entries: [
          {
            step: "partial settlement at 1.40",
            lines: [
              { accountId: ctx.roles.ar, amount: `-${consumed}` },
              { accountId: ctx.roles.bank, amount: cash },
              { accountId: ctx.roles.fxRealizedGainLoss, amount: adjustment },
            ],
          },
        ],
      };
    },
  },

  {
    id: "fx-settlement-full-consumes-residual",
    title: "Settling the complete foreign balance consumes the complete carrying value",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.28",
        kind: "requirement",
        requirement:
          "Exchange differences arising on settling monetary items are recognised in profit or loss in the period in which they arise.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Taking the complete residual consumes the complete carrying value — including a sub-cent rounding tail — so proportional rounding can never strand an uncloseable one-unit balance on a fully settled item.",
    facts: [
      "A USD balance fully settled: open foreign 1,000.00, settled foreign 1,000.00.",
      "The carrying value is CAD 1,350.0001, with a 0.0001 rounding tail from earlier proportional settlements.",
      "The consumed carrying value is exactly CAD 1,350.0001 — not the proportionally rounded 1,350.0000.",
    ],
    expected: {
      values: { consumedBase: "1350.0001" },
    },
    run: () => {
      const consumed = carryingAmountForSettlement("1350.0001", "1000.00", "1000.00");
      return { values: { consumedBase: consumed } };
    },
  },

  {
    id: "fx-nonmonetary-asset-at-historical-cost",
    title: "A non-monetary asset measured at historical cost is not retranslated",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.23(b)",
        kind: "requirement",
        requirement:
          "Non-monetary items measured at historical cost are translated using the exchange rate at the date of the transaction and are not retranslated.",
      },
      {
        standard: "ASC 830",
        reference: "ASC 830-10-45-17",
        kind: "requirement",
        requirement:
          "Non-monetary balances are remeasured using the historical exchange rate in effect when the transaction occurred, not the current rate.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Equipment bought in a foreign currency keeps its transaction-date translated cost through a period-end close that moves the rate: the revaluation run finds no monetary exposure in the asset or its matching foreign-currency liability and posts nothing — neither a gain nor a loss, and no restatement of cost.",
    facts: [
      "The reporting currency is CAD.",
      "Equipment bought for USD 5,000.00 on 2026-07-15 at 1.3500 is carried at CAD 6,750.00 against a matching USD loan carried at CAD 6,750.00.",
      "Neither account is designated a monetary item: fixed assets are carried at historical cost and this loan account carries no monetary flag.",
      "The closing rate on 2026-07-31 is 1.4000.",
      "The period-end revaluation posts nothing — the equipment stays at CAD 6,750.00.",
    ],
    expected: {
      entries: [{ step: "period-end retranslation at 2026-07-31", lines: [] }],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${ledger.orgId}`);
      await setSpotRate(ledger, "USD", "CAD", "2026-07-15", "1.35");
      await postNewDocument(ctx, {
        kind: "journal",
        number: "CONF-FXS-1",
        currency: "USD",
        fxRate: "1.35",
        date: "2026-07-15",
        lines: [
          { accountId: ctx.roles.fixedAsset, quantity: "1", unitPrice: "5000", amount: "5000" },
          { accountId: ctx.roles.loanPayable, quantity: "1", unitPrice: "-5000", amount: "-5000" },
        ],
      });

      await setSpotRate(ledger, "USD", "CAD", "2026-07-31", "1.40");
      const periodId = await periodFor(ledger, "2026-07-31");
      const revaluation = await capture(
        ctx,
        "period-end retranslation at 2026-07-31",
        async () => {
          const result = await runRevaluation(ledger.orgId, periodId, ledger.actorId);
          if (result.problems.length > 0) {
            throw new Error(`revaluation reported problems: ${result.problems.join("; ")}`);
          }
        },
        { asOf: "2026-07-31" },
      );
      return { entries: [revaluation] };
    },
  },

  {
    id: "fx-net-investment-oci",
    title: "Exchange differences on a net investment in a foreign operation",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.32",
        kind: "requirement",
        requirement:
          "Exchange differences on a monetary item that forms part of the reporting entity's net investment in a foreign operation are recognised in other comprehensive income, not in profit or loss.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "A long-term intercompany balance that is in substance part of a net investment in a foreign operation has its exchange differences recognised in other comprehensive income until the investment is disposed of.",
    facts: [
      "A CAD parent holds a USD subsidiary financed by a long-term intercompany loan with no planned settlement.",
      "The loan is designated part of the net investment in the foreign operation.",
      "At the closing rate the loan carries an exchange difference of CAD 500.00.",
      "The required outcome is a CAD 500.00 movement in other comprehensive income, with nothing in profit or loss.",
    ],
    gap:
      "The product has no net-investment designation for intercompany monetary items: every monetary exchange difference the revaluation engine computes is offset to the profit-or-loss unrealized gain/loss account, and there is no other-comprehensive-income reserve for foreign-operation differences in the ledger.",
    expected: {
      values: { ociMovement: "500.0000", profitOrLossMovement: "0.0000" },
    },
  },
];

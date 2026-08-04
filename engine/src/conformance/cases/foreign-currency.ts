/**
 * The effects of changes in foreign exchange rates — IAS 21 (and the equivalent
 * US GAAP requirements in ASC 830, which are cited where they add nothing new
 * only by omission — this file cites IAS 21 as the operative source).
 */

import { computeRevaluation } from "../../fx-revaluation.ts";
import { runRevaluation } from "../../fx-revaluation.ts";
import { capture, periodFor, postNewDocument, setSpotRate } from "../ledger-helpers.ts";
import type { ConformanceCase } from "../types.ts";

export const FOREIGN_CURRENCY_CASES: readonly ConformanceCase[] = [
  {
    id: "fx-initial-recognition-at-spot",
    title: "A foreign-currency transaction is recorded at the spot rate on the transaction date",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.21",
        kind: "requirement",
        requirement:
          "A foreign currency transaction is recorded on initial recognition by applying the spot exchange rate at the date of the transaction to the foreign currency amount.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A sale invoiced in a foreign currency enters the books translated at that day's spot rate, and both the receivable and the revenue carry the same translated amount — no rate is applied to one leg and not the other.",
    facts: [
      "The reporting currency is CAD.",
      "A sale of USD 1,000.00 is invoiced on 2026-07-15.",
      "The spot rate on 2026-07-15 is 1.3500 CAD per USD.",
      "The translated amount is CAD 1,350.00.",
    ],
    expected: {
      entries: [
        {
          step: "foreign-currency sale",
          lines: [
            { role: "ar", amount: "1350.0000" },
            { role: "revenue", amount: "-1350.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await setSpotRate(ledger, "USD", "CAD", "2026-07-15", "1.35");
      const sale = await capture(ctx, "foreign-currency sale", async () => {
        await postNewDocument(ctx, {
          kind: "customer_invoice",
          number: "CONF-FX-1",
          partyId: ledger.customerId,
          currency: "USD",
          fxRate: "1.35",
          date: "2026-07-15",
          lines: [
            { accountId: ctx.roles.revenue, quantity: "1", unitPrice: "1000", amount: "1000" },
          ],
        });
      });
      return { entries: [sale] };
    },
  },

  {
    id: "fx-monetary-item-retranslated-at-closing-rate",
    title: "Monetary items are retranslated at the closing rate and the difference goes to profit or loss",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.23(a)",
        kind: "requirement",
        requirement:
          "At the end of each reporting period foreign currency monetary items are translated using the closing rate.",
      },
      {
        standard: "IAS 21",
        reference: "IAS 21.28",
        kind: "requirement",
        requirement:
          "Exchange differences arising on settling or retranslating monetary items are recognised in profit or loss in the period in which they arise.",
      },
      {
        standard: "IAS 21",
        reference: "IAS 21.23(b)",
        kind: "requirement",
        requirement:
          "Non-monetary items measured at historical cost are translated using the exchange rate at the date of the transaction and are not retranslated.",
      },
    ],
    support: "partial",
    tier: "ledger",
    limitation:
      "The monetary-item population is narrower than IAS 21.16 requires. Period-end retranslation covers accounts typed as bank, receivable and payable only. Foreign-currency loans and other long-term debt, accrued liabilities, and other monetary balances carried outside those three account types are NOT retranslated and must be adjusted by manual journal.",
    assertion:
      "A foreign-currency receivable is restated to the closing rate at the reporting date, the movement is recognised immediately in profit or loss, and the revenue already recognised at the transaction-date rate is left untouched.",
    facts: [
      "A receivable of USD 1,000.00 was recognised on 2026-07-15 at 1.3500, carried at CAD 1,350.00.",
      "The closing rate on 2026-07-31 is 1.4000 CAD per USD.",
      "The receivable is restated to CAD 1,400.00, an increase of CAD 50.00.",
      "The exchange gain of CAD 50.00 is recognised in profit or loss.",
      "Revenue stays at CAD 1,350.00 — it is not a monetary item and is not retranslated.",
    ],
    expected: {
      entries: [
        {
          step: "period-end retranslation at 2026-07-31",
          lines: [
            { role: "ar", amount: "50.0000" },
            { role: "fxUnrealizedGainLoss", amount: "-50.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await setSpotRate(ledger, "USD", "CAD", "2026-07-15", "1.35");
      await postNewDocument(ctx, {
        kind: "customer_invoice",
        number: "CONF-FX-2",
        partyId: ledger.customerId,
        currency: "USD",
        fxRate: "1.35",
        date: "2026-07-15",
        lines: [{ accountId: ctx.roles.revenue, quantity: "1", unitPrice: "1000", amount: "1000" }],
      });

      await setSpotRate(ledger, "USD", "CAD", "2026-07-31", "1.40");
      const periodId = await periodFor(ledger, "2026-07-31");

      // Measured AS AT the reporting date: the process also books the mirror
      // reversal into the next period, which a 31 July balance sheet excludes.
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
    id: "fx-retranslation-arithmetic",
    title: "Retranslation restates the foreign balance and offsets the whole movement to profit or loss",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.23(a)",
        kind: "requirement",
        requirement:
          "Foreign currency monetary items are translated at the closing rate at the end of the reporting period.",
      },
      {
        standard: "IAS 21",
        reference: "IAS 21.28",
        kind: "requirement",
        requirement:
          "Exchange differences on monetary items are recognised in profit or loss in the period in which they arise.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Across several currencies and both directions of movement, each monetary balance is restated to foreign balance times closing rate and the net of every restatement lands in a single profit-or-loss account — the entry cannot leave a residual.",
    facts: [
      "A USD receivable of 1,000.00 carried at CAD 1,350.00 with a closing rate of 1.4000 restates to 1,400.00, a gain of 50.00.",
      "A EUR payable of −2,000.00 carried at CAD −2,900.00 with a closing rate of 1.5000 restates to −3,000.00, a loss of 100.00.",
      "The net movement of −50.00 is offset to unrealised exchange gain or loss.",
    ],
    expected: {
      entries: [
        {
          step: "retranslation",
          lines: [
            { role: "ar", amount: "50.0000" },
            { role: "ap", amount: "-100.0000" },
            { role: "fxUnrealizedGainLoss", amount: "50.0000" },
          ],
        },
      ],
      values: { netDelta: "-50.0000" },
    },
    run: (ctx) => {
      const { lines, netDelta } = computeRevaluation(
        [
          {
            accountId: ctx.roles.ar,
            currency: "USD",
            carryingBase: "1350.00",
            foreignBalance: "1000.00",
            periodEndRate: "1.40",
          },
          {
            accountId: ctx.roles.ap,
            currency: "EUR",
            carryingBase: "-2900.00",
            foreignBalance: "-2000.00",
            periodEndRate: "1.50",
          },
        ],
        ctx.roles.fxUnrealizedGainLoss,
      );
      return {
        entries: [{ step: "retranslation", lines }],
        values: { netDelta },
      };
    },
  },

  {
    id: "fx-unchanged-rate-posts-nothing",
    title: "An unchanged closing rate produces no entry",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.28",
        kind: "requirement",
        requirement:
          "Exchange differences are recognised only when they arise; where no difference arises, none is recognised.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A period in which rates did not move generates no journal entry at all, so period-end processing cannot manufacture immaterial noise in the ledger or in the exchange gain and loss account.",
    facts: [
      "A USD receivable of 1,000.00 carried at CAD 1,350.00.",
      "The closing rate is unchanged at 1.3500.",
    ],
    expected: { entries: [{ step: "retranslation", lines: [] }], values: { netDelta: "0" } },
    run: (ctx) => {
      const { lines, netDelta } = computeRevaluation(
        [
          {
            accountId: ctx.roles.ar,
            currency: "USD",
            carryingBase: "1350.00",
            foreignBalance: "1000.00",
            periodEndRate: "1.35",
          },
        ],
        ctx.roles.fxUnrealizedGainLoss,
      );
      return { entries: [{ step: "retranslation", lines }], values: { netDelta } };
    },
  },
];

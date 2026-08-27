/**
 * The effects of changes in foreign exchange rates — IAS 21 (and the equivalent
 * US GAAP requirements in ASC 830, which are cited where they add nothing new
 * only by omission — this file cites IAS 21 as the operative source).
 *
 * The multi-line cases at the end exist because the original five could not
 * fail on FX rounding: every rate was two decimals against two-decimal
 * amounts, exact at the ledger's four decimals, and a two-leg entry cannot
 * drift under sign-symmetric half-up rounding anyway. They drive the inverse
 * of a one-direction pair — the rate an organisation actually holds when its
 * exchange table stores only CAD→USD — at ten decimals, across three-leg
 * entries whose per-line roundings genuinely miss zero.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { computeRevaluation, runRevaluation } from "../../fx-revaluation.ts";
import { postDocument } from "../../posting.ts";
import { capture, deps, periodFor, postNewDocument, setSpotRate } from "../ledger-helpers.ts";
import type { ConformanceCase } from "../types.ts";

/**
 * journal_lines stamps fx_rate as numeric(19,10), whose text keeps all ten
 * decimals. Scaling by 10^10 therefore turns the stored rate into an exact
 * integer — which the corpus's 4dp money comparison can hold to equality
 * without loosening it.
 */
function rateScaledBy1e10(rate: string): string {
  const [whole = "", fraction = ""] = rate.trim().split(".");
  return BigInt(`${whole}${fraction.padEnd(10, "0")}`).toString();
}

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
    support: "supported",
    tier: "ledger",
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
    id: "fx-long-term-debt-retranslated",
    title: "A foreign-currency loan is a monetary item and is retranslated at the closing rate",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.16",
        kind: "requirement",
        requirement:
          "Monetary items are units of currency held and assets and liabilities to be received or paid in a fixed or determinable number of units of currency — including debt, not only trade balances.",
      },
      {
        standard: "IAS 21",
        reference: "IAS 21.23(a)",
        kind: "requirement",
        requirement:
          "At the end of each reporting period foreign currency monetary items are translated using the closing rate.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A foreign-currency borrowing carried as long-term debt — outside the bank/receivable/payable account types — is retranslated at the closing rate once the account is designated a monetary item, so debt-heavy balance sheets are not silently left at historical rates.",
    facts: [
      "The reporting currency is CAD.",
      "A loan of USD 10,000.00 is drawn on 2026-07-15 at 1.3500: cash CAD 13,500.00, loan CAD 13,500.00.",
      "The loan account is a long-term liability designated as a monetary item.",
      "The closing rate on 2026-07-31 is 1.4000.",
      "Both the USD cash (a default monetary item) and the USD loan restate by CAD 500.00 in opposite directions; the exchange loss on the loan offsets the gain on the cash.",
    ],
    expected: {
      entries: [
        {
          step: "period-end retranslation at 2026-07-31",
          lines: [
            { role: "bank", amount: "500.0000" },
            { role: "loanPayable", amount: "-500.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      // Designate the loan account a monetary item (the account-level setting
      // an administrator edits on the chart of accounts).
      await db.execute(sql`
        update accounts set monetary = true
         where id = ${ctx.roles.loanPayable} and org_id = ${ledger.orgId}`);

      await setSpotRate(ledger, "USD", "CAD", "2026-07-15", "1.35");
      await postNewDocument(ctx, {
        kind: "journal",
        number: "CONF-FX-3",
        currency: "USD",
        fxRate: "1.35",
        date: "2026-07-15",
        lines: [
          { accountId: ctx.roles.bank, quantity: "1", unitPrice: "10000", amount: "10000" },
          { accountId: ctx.roles.loanPayable, quantity: "1", unitPrice: "-10000", amount: "-10000" },
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

  {
    id: "fx-inverse-rate-multiline-balance",
    title: "A multi-line invoice translates balanced through a ten-decimal inverse rate",
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
      "A multi-line sale invoiced in USD at the ten-decimal inverse of a stored CAD→USD pair — 1.4285714286, exactly the figure posting derives itself as (1 / 0.7)::numeric(19,10) when the exchange table holds only one direction — lands in CAD with every line translated independently and the entry balancing to exactly zero; per-line rounding never leaks a residual into any account, least of all a control account.",
    facts: [
      "The reporting currency is CAD; the FX registry stores the pair only one way, CAD→USD 0.7000 on 2026-07-22.",
      "The invoice carries the inverse spot figure 1.4285714286 (numeric(19,10), what (1/0.7) truncates to) as its transaction rate — no tidy two-decimal approximation that would make rounding impossible.",
      "Two revenue lines of USD 1,234.56 and USD 765.44 (total USD 2,000.00) plus the receivable leg make THREE legs, so per-line half-up rounding can no longer cancel by sign symmetry.",
      "Translations round independently: revenue 1,763.6571 and 1,093.4857 against a receivable of 2,857.1429 — the individual roundings miss zero by one ledger unit.",
      "That rounding residual is absorbed within the same entry, leaving AR at CAD 2,857.1429 against revenue at CAD −2,857.1429, and every journal line stamped with the ten-decimal rate actually applied.",
    ],
    expected: {
      entries: [
        {
          step: "multi-line USD invoice at ten-decimal inverse rate",
          lines: [
            { role: "ar", amount: "2857.1429" },
            { role: "revenue", amount: "-2857.1429" },
          ],
        },
      ],
      values: { fxRateAppliedE10: "14285714286" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      // One direction only on the registry: the inverse of this row is where
      // ten-decimal rates come from.
      await setSpotRate(ledger, "CAD", "USD", "2026-07-22", "0.70");
      let entryId = "";
      const invoice = await capture(ctx, "multi-line USD invoice at ten-decimal inverse rate", async () => {
        entryId = await postNewDocument(ctx, {
          kind: "customer_invoice",
          number: "CONF-FX-6",
          partyId: ledger.customerId,
          currency: "USD",
          fxRate: "1.4285714286",
          date: "2026-07-22",
          lines: [
            { accountId: ctx.roles.revenue, quantity: "1", unitPrice: "1234.56", amount: "1234.56" },
            { accountId: ctx.roles.revenue, quantity: "1", unitPrice: "765.44", amount: "765.44" },
          ],
        });
      });
      const rates = await db.execute<{ fx_rate: string }>(sql`
        select distinct fx_rate::text as fx_rate
          from journal_lines
         where org_id = ${ledger.orgId} and entry_id = ${entryId}`);
      const applied =
        [...new Set(rates.rows.map((row) => rateScaledBy1e10(row.fx_rate)))].sort().join(",");
      return { entries: [invoice], values: { fxRateAppliedE10: applied } };
    },
  },

  {
    id: "fx-inverse-rate-statutory-tax-exact",
    title:
      "Output tax on a foreign-currency invoice equals the translated statutory amount exactly, and the translation residual lands on a trading line",
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
      "On a taxed, multi-line USD invoice translated through a ten-decimal rate whose per-line roundings do NOT reconcile, the tax control lines carry exactly tax-total × spot rate and the one-unit translation residual is absorbed by a revenue line — no translation residual is parked on a statutory return line where it would flow straight into a filed figure.",
    facts: [
      "The reporting currency is CAD; CAD→USD 0.8100 is the stored direction, and the invoice posts at its ten-decimal inverse 1.2345679012 (what (1/0.81)::numeric(19,10) truncates to) — no tidy two-decimal approximation that would make rounding impossible.",
      "Revenue lines of USD 33.33, 33.33 and 33.34 (total USD 100.00) carry statutory output tax at 5%: USD 1.6665, 1.6665 and 1.6670 (tax total USD 5.0000).",
      "The per-line translations genuinely miss zero: revenue 41.1481, 41.1481, 41.1605; tax 2.0574, 2.0574, 2.0580; receivable 129.6296 — the roundings leave a one-ledger-unit residual, so the absorption rule actually executes.",
      "The residual is absorbed by the largest revenue line (41.1605 → 41.1606); every tax control line keeps its exact statutory translation, so tax payable shows exactly CAD 6.1728.",
    ],
    expected: {
      entries: [
        {
          step: "taxed multi-line USD invoice at ten-decimal inverse rate",
          lines: [
            { role: "ar", amount: "129.6296" },
            { role: "revenue", amount: "-123.4568" },
            { role: "taxPayable", amount: "-6.1728" },
          ],
        },
      ],
      values: { fxRateAppliedE10: "12345679012" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      // One direction only on the registry: the inverse of this row is where
      // ten-decimal rates come from.
      await setSpotRate(ledger, "CAD", "USD", "2026-07-23", "0.81");
      const taxCodeId = randomUUID();
      const documentId = randomUUID();
      const lineIds = [randomUUID(), randomUUID(), randomUUID()];
      await db.execute(sql`
        insert into tax_codes (id, org_id, code, name, collected_account_id)
        values (${taxCodeId}, ${ledger.orgId}, 'CONF-FX-VAT', 'Statutory Output Tax', ${ctx.roles.taxPayable})`);

      let entryId = "";
      const invoice = await capture(ctx, "taxed multi-line USD invoice at ten-decimal inverse rate", async () => {
        // Tax calculation evidence is immutably bound while the document is
        // still a draft (kernel guard), so this fixture builds its own draft —
        // lines, evidence, and approval lifecycle included. The amounts are
        // chosen so the per-line translations MISS zero by one ledger unit:
        // the absorption rule must run, and must run onto a revenue line.
        await db.execute(sql`
          insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id,
                                 document_date, posting_date, currency, fx_rate, status,
                                 subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
          values (${documentId}, ${ledger.orgId}, 'customer_invoice', 'CONF-FX-7', ${ledger.customerId},
                  ${ledger.subsidiaryId}, '2026-07-23', '2026-07-23', 'USD', '1.2345679012', 'draft',
                  '100.00', '0', '100.00', false, '{}'::jsonb, '{}'::jsonb)`);
        const taxableLines = [
          { id: lineIds[0]!, amount: "33.33", tax: "1.6665" },
          { id: lineIds[1]!, amount: "33.33", tax: "1.6665" },
          { id: lineIds[2]!, amount: "33.34", tax: "1.6670" },
        ];
        for (const [index, line] of taxableLines.entries()) {
          await db.execute(sql`
            insert into document_lines (id, org_id, document_id, line_number, item_id, account_id,
                                        quantity, unit_price, amount, tax_amount, is_billable,
                                        quantity_fulfilled, quantity_billed, stock_location_id,
                                        custom, tax_overridden, extra_dims)
            values (${line.id}, ${ledger.orgId}, ${documentId}, ${index + 1}, null, ${ctx.roles.revenue},
                    '1', ${line.amount}, ${line.amount}, ${line.tax}, false, '0', '0', null,
                    '{}'::jsonb, false, '{}'::jsonb)`);
          await db.execute(sql`
            insert into document_line_tax_components
              (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
               tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
               collected_account_id)
            values (${ledger.orgId}, ${line.id}, ${taxCodeId}, 1, '5', ${line.amount},
                    ${line.tax}, ${line.tax}, '0', 'standard', ${ctx.roles.taxPayable})`);
        }
        await db.execute(sql`
          update documents
             set status = 'approved', tax_total = '5.00', total = subtotal + '5.00'
           where org_id = ${ledger.orgId} and id = ${documentId}`);
        entryId = await postDocument(documentId, deps(ctx));
      });
      const rates = await db.execute<{ fx_rate: string }>(sql`
        select distinct fx_rate::text as fx_rate
          from journal_lines
         where org_id = ${ledger.orgId} and entry_id = ${entryId}`);
      const applied =
        [...new Set(rates.rows.map((row) => rateScaledBy1e10(row.fx_rate)))].sort().join(",");
      return { entries: [invoice], values: { fxRateAppliedE10: applied } };
    },
  },
];

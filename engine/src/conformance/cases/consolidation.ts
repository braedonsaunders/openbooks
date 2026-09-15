/**
 * Consolidation — IFRS 10 / ASC 810 (control), IAS 28 / ASC 323 (associates),
 * IFRS 11 (joint operations), IAS 21.39 / ASC 830-30 (foreign translation).
 *
 * These cases drive the product's actual consolidation machinery against a
 * scratch tenant: `runOwnershipConsolidation` (acquisition elimination, NCI,
 * equity method, translated through `deriveConsolidatedRates`) and
 * `runAutoElimination` (period intercompany netting). Fixtures post straight
 * to journal_entries/journal_lines the way the engine's own consolidation
 * tests do — the runs under test read posted journal entries, not source
 * documents — and `capture` observes the complete ledger movement each run
 * causes. Amounts are stated in the subsidiary's functional currency and
 * translated by the engine, never pre-translated by the case.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  deriveConsolidatedRates,
  runAutoElimination,
  runOwnershipConsolidation,
} from "../../consolidation.ts";
import { db } from "../../db.ts";
import { capture, setSpotRate } from "../ledger-helpers.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

interface FixtureLine {
  accountId: string;
  /** Signed amount in the entry subsidiary's functional currency. */
  amount: string;
  currency: string;
}

/**
 * Post balanced journal lines straight to the ledger (the consolidation runs
 * read posted entries). One transaction: the entry-balance triggers are
 * deferred to commit, so the entry must arrive whole — line-by-line
 * autocommit inserts trip the balance check on the first unbalanced line.
 */
async function postFixtureEntry(
  ctx: CaseContext,
  subsidiaryId: string,
  number: string,
  date: string,
  memo: string,
  lines: FixtureLine[],
): Promise<void> {
  const ledger = ctx.ledger!;
  const entryId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entryId}, ${ledger.orgId}, ${ledger.bookId}, ${subsidiaryId}, ${number}, ${date}, ${ledger.periodId}, ${memo}, 'draft', 'manual')`);
    for (const [index, line] of lines.entries()) {
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${ledger.orgId}, ${entryId}, ${index + 1}, ${line.accountId}, ${subsidiaryId}, ${line.amount}, ${line.currency}, ${line.amount}, '1')`);
    }
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  });
}

async function addSubsidiary(
  ctx: CaseContext,
  name: string,
  baseCurrency: string,
  country: string,
  isElimination: boolean,
): Promise<string> {
  const ledger = ctx.ledger!;
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values
      (${id}, ${ledger.orgId}, ${ledger.subsidiaryId}, ${name}, ${baseCurrency}, ${country}, '{}'::jsonb, ${isElimination}, true, '{}'::jsonb)`);
  return id;
}

interface OwnershipPolicy {
  subsidiaryId: string;
  ownershipPercent: string;
  method: "full" | "proportionate" | "equity";
  acquisitionDate: string;
  acquisitionCost: string;
  fairValueNetAssets: string;
  acquisitionRate: string;
  nciMeasurement?: "proportionate" | "fair_value";
  nciFairValue?: string | null;
  distributionAccountId?: string | null;
  distributionIncomeAccountId?: string | null;
  nciEquityAccountId?: string | null;
  nciIncomeAccountId?: string | null;
}

async function addOwnershipPolicy(ctx: CaseContext, policy: OwnershipPolicy): Promise<void> {
  const ledger = ctx.ledger!;
  await db.execute(sql`
    insert into subsidiary_ownership_interests
      (id, org_id, parent_subsidiary_id, subsidiary_id, effective_from, ownership_percent, method,
       acquisition_date, acquisition_cost, fair_value_net_assets, acquisition_rate, nci_measurement, nci_fair_value,
       investment_account_id, equity_income_account_id,
       distribution_account_id, distribution_income_account_id,
       nci_equity_account_id, nci_income_account_id,
       goodwill_account_id, fair_value_adjustment_account_id)
    values (${randomUUID()}, ${ledger.orgId}, ${ledger.subsidiaryId}, ${policy.subsidiaryId}, ${policy.acquisitionDate},
            ${policy.ownershipPercent}, ${policy.method}, ${policy.acquisitionDate}, ${policy.acquisitionCost},
            ${policy.fairValueNetAssets}, ${policy.acquisitionRate}, ${policy.nciMeasurement ?? "proportionate"},
            ${policy.nciFairValue ?? null}, ${ctx.roles.investmentInSub}, ${ctx.roles.equityMethodIncome},
            ${policy.distributionAccountId ?? null}, ${policy.distributionIncomeAccountId ?? null},
            ${policy.nciEquityAccountId ?? null}, ${policy.nciIncomeAccountId ?? null},
            ${ctx.roles.goodwill}, ${ctx.roles.fairValueAdjustment})`);
}

/** Run the ownership phase and return its complete ledger movement as one entry. */
async function captureOwnership(ctx: CaseContext, label: string) {
  const ledger = ctx.ledger!;
  return capture(ctx, label, async () => {
    await runOwnershipConsolidation(ledger.orgId, ledger.periodId, ledger.actorId);
  });
}

export const CONSOLIDATION_CASES: readonly ConformanceCase[] = [
  {
    id: "consol-full-nci-acquisition",
    title: "Full consolidation eliminates the subsidiary and recognises NCI",
    citations: [
      {
        standard: "IFRS 10",
        reference: "IFRS 10.22",
        kind: "requirement",
        requirement:
          "A parent presents non-controlling interests in the consolidated statement of financial position within equity, separately from the equity of the owners of the parent.",
      },
      {
        standard: "IFRS 10",
        reference: "IFRS 10.B94",
        kind: "requirement",
        requirement:
          "A parent attributes the profit or loss of a subsidiary between the owners of the parent and the non-controlling interests, even when the attribution leaves the non-controlling interests with a deficit.",
      },
      {
        standard: "ASC 810",
        reference: "ASC 810-10-45-16",
        kind: "requirement",
        requirement:
          "Non-controlling interests are reported in consolidated equity separately from the parent's equity, and consolidated net income is allocated between the parent and the non-controlling interests.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Acquiring 80% of a subsidiary eliminates its acquisition-date equity against the parent's investment, recognises the 20% non-controlling interest at its proportionate share of fair value with goodwill for the remainder, and allocates 20% of the period's profit to NCI — every leg exact to the cent.",
    facts: [
      "A parent pays CAD 900.00 for 80% of a subsidiary whose book equity is CAD 800.00 and whose fair value of net assets is CAD 1,000.00.",
      "The non-controlling interest is 20% of 1,000.00 = CAD 200.00; goodwill is 900.00 + 200.00 − 1,000.00 = CAD 100.00.",
      "The subsidiary earns CAD 100.00 after acquisition; the NCI share of profit is 100.00 × 20% = CAD 20.00.",
      "The elimination debits subsidiary equity 800.00, fair-value adjustment 200.00 and goodwill 100.00, credits the investment 900.00 and NCI equity 200.00; the income allocation debits NCI income 20.00 and credits NCI equity 20.00, leaving NCI equity at a 220.00 credit.",
    ],
    expected: {
      entries: [
        {
          step: "ownership consolidation",
          lines: [
            { role: "subsidiaryEquity", amount: "800.0000" },
            { role: "fairValueAdjustment", amount: "200.0000" },
            { role: "goodwill", amount: "100.0000" },
            { role: "investmentInSub", amount: "-900.0000" },
            { role: "nciEquity", amount: "-220.0000" },
            { role: "nciIncome", amount: "20.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const childId = await addSubsidiary(ctx, "Sub Co", "CAD", "CA", false);
      await addSubsidiary(ctx, "Eliminations", "CAD", "CA", true);
      await postFixtureEntry(ctx, childId, "CONF-C1-CAP", "2026-07-01", "Opening equity", [
        { accountId: ctx.roles.bank, amount: "800", currency: "CAD" },
        { accountId: ctx.roles.subsidiaryEquity, amount: "-800", currency: "CAD" },
      ]);
      await postFixtureEntry(ctx, childId, "CONF-C1-PROFIT", ledger.date, "Period profit", [
        { accountId: ctx.roles.bank, amount: "100", currency: "CAD" },
        { accountId: ctx.roles.revenue, amount: "-100", currency: "CAD" },
      ]);
      await addOwnershipPolicy(ctx, {
        subsidiaryId: childId,
        ownershipPercent: "80",
        method: "full",
        acquisitionDate: "2026-07-01",
        acquisitionCost: "900",
        fairValueNetAssets: "1000",
        acquisitionRate: "1",
        nciEquityAccountId: ctx.roles.nciEquity,
        nciIncomeAccountId: ctx.roles.nciIncome,
      });
      const entry = await captureOwnership(ctx, "ownership consolidation");
      return { entries: [entry] };
    },
  },

  {
    id: "consol-intercompany-elimination",
    title: "Intercompany balances eliminate to zero while standalone views stay untouched",
    citations: [
      {
        standard: "IFRS 10",
        reference: "IFRS 10.B86",
        kind: "requirement",
        requirement:
          "A parent eliminates in full intragroup assets and liabilities, equity, income, expenses and cash flows relating to transactions between entities of the group.",
      },
      {
        standard: "ASC 810",
        reference: "ASC 810-10-45-1",
        kind: "requirement",
        requirement:
          "Intra-entity balances and transactions are eliminated in preparing consolidated statements.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A CAD 1,000.00 intercompany receivable on the parent exactly offsets the subsidiary's CAD 1,000.00 payable, and the elimination entry reverses both — the consolidated view nets to zero while the source postings on each entity stand unchanged.",
    facts: [
      "The parent sells CAD 1,000.00 to the subsidiary: parent receivable debit 1,000.00 against revenue; subsidiary cost debit 1,000.00 against payable credit 1,000.00.",
      "Receivable and payable carry the elimination flag; revenue and cost do not.",
      "The elimination entry credits the receivable 1,000.00 and debits the payable 1,000.00 — balanced, with no residual.",
      "Every source line stays posted on its own entity; only the elimination subsidiary carries the reversal.",
    ],
    expected: {
      entries: [
        {
          step: "intercompany elimination",
          lines: [
            { role: "ar", amount: "-1000.0000" },
            { role: "ap", amount: "1000.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const childId = await addSubsidiary(ctx, "Sub Co", "CAD", "CA", false);
      await addSubsidiary(ctx, "Eliminations", "CAD", "CA", true);
      await db.execute(sql`
        update accounts set eliminate = true
         where id in (${ctx.roles.ar}, ${ctx.roles.ap}) and org_id = ${ledger.orgId}`);
      await postFixtureEntry(ctx, ledger.subsidiaryId, "CONF-C2-SALE", ledger.date, "Intercompany sale", [
        { accountId: ctx.roles.ar, amount: "1000", currency: "CAD" },
        { accountId: ctx.roles.revenue, amount: "-1000", currency: "CAD" },
      ]);
      await postFixtureEntry(ctx, childId, "CONF-C2-BUY", ledger.date, "Intercompany purchase", [
        { accountId: ctx.roles.cogs, amount: "1000", currency: "CAD" },
        { accountId: ctx.roles.ap, amount: "-1000", currency: "CAD" },
      ]);
      const entry = await capture(ctx, "intercompany elimination", async () => {
        await runAutoElimination(ledger.orgId, ledger.periodId, ledger.actorId);
      });
      return { entries: [entry] };
    },
  },

  {
    id: "consol-equity-method",
    title: "An associate's profit increases the investment and its dividend reduces it",
    citations: [
      {
        standard: "IAS 28",
        reference: "IAS 28.16",
        kind: "requirement",
        requirement:
          "Under the equity method the investment is adjusted for the investor's share of the associate's post-acquisition profit or loss, and distributions received reduce the carrying amount of the investment.",
      },
      {
        standard: "ASC 323",
        reference: "ASC 323-10-35-4",
        kind: "requirement",
        requirement:
          "An investor recognises its share of the earnings of an investee in the periods they are reported, and dividends received are applied against the carrying amount of the investment.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A 30% associate earning CAD 200.00 and declaring CAD 50.00 of dividends lifts the investment by CAD 45.00 in one entry — CAD 60.00 of equity income less the CAD 15.00 dividend share — with no NCI and no acquisition elimination, because an associate is never combined line by line.",
    facts: [
      "The investor holds 30% of an associate accounted for by the equity method.",
      "The associate earns CAD 200.00 after acquisition; the investor's share is 200.00 × 30% = CAD 60.00 of equity income, debiting the investment.",
      "The associate declares CAD 50.00 of dividends; the investor's 15.00 share credits the investment and eliminates the matching dividend income.",
      "The investment moves by 60.00 − 15.00 = CAD 45.00 debit; equity income shows a 60.00 credit and dividend income a 15.00 debit.",
    ],
    expected: {
      entries: [
        {
          step: "ownership consolidation",
          lines: [
            { role: "investmentInSub", amount: "45.0000" },
            { role: "equityMethodIncome", amount: "-60.0000" },
            { role: "distributionIncome", amount: "15.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const associateId = await addSubsidiary(ctx, "Associate Co", "CAD", "CA", false);
      await addSubsidiary(ctx, "Eliminations", "CAD", "CA", true);
      await postFixtureEntry(ctx, associateId, "CONF-C3-PROFIT", ledger.date, "Associate profit", [
        { accountId: ctx.roles.bank, amount: "200", currency: "CAD" },
        { accountId: ctx.roles.revenue, amount: "-200", currency: "CAD" },
      ]);
      // Dividends declared live on their own equity account: the policy's
      // distribution account must capture only the dividend, never capital.
      const dividendsDeclaredId = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                              required_dimensions, custom, subsidiary_include_children)
        values (${dividendsDeclaredId}, ${ledger.orgId}, '3050', 'Dividends Declared', 'equity', false, true, false, false,
                '[]'::jsonb, '{}'::jsonb, true)`);
      await postFixtureEntry(ctx, associateId, "CONF-C3-DIV", ledger.date, "Associate dividend", [
        { accountId: dividendsDeclaredId, amount: "50", currency: "CAD" },
        { accountId: ctx.roles.bank, amount: "-50", currency: "CAD" },
      ]);
      await postFixtureEntry(ctx, ledger.subsidiaryId, "CONF-C3-RECEIPT", ledger.date, "Dividend receipt", [
        { accountId: ctx.roles.bank, amount: "50", currency: "CAD" },
        { accountId: ctx.roles.distributionIncome, amount: "-50", currency: "CAD" },
      ]);
      await addOwnershipPolicy(ctx, {
        subsidiaryId: associateId,
        ownershipPercent: "30",
        method: "equity",
        acquisitionDate: "2026-07-01",
        acquisitionCost: "300",
        fairValueNetAssets: "1000",
        acquisitionRate: "1",
        distributionAccountId: dividendsDeclaredId,
        distributionIncomeAccountId: ctx.roles.distributionIncome,
      });
      const entry = await captureOwnership(ctx, "ownership consolidation");
      return { entries: [entry] };
    },
  },

  {
    id: "consol-proportionate-owned-share",
    title: "Proportionate consolidation combines only the owned share, with no NCI",
    citations: [
      {
        standard: "IFRS 11",
        reference: "IFRS 11.20",
        kind: "requirement",
        requirement:
          "A joint operator recognises its share of the jointly held assets, liabilities, revenues and expenses — only the owned share is ever combined, so there is no non-controlling interest to present.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A 50%-owned joint operation eliminates the owned half of its acquisition-date equity against the parent's investment with no NCI entry at all — the reporting layer weights the subsidiary's lines, so the run posts the owned-share elimination and stops.",
    facts: [
      "The parent pays CAD 550.00 for 50% of a joint operation with book equity of CAD 1,000.00 and fair value of net assets of CAD 1,000.00.",
      "The owned share of equity is 1,000.00 × 50% = CAD 500.00; the fair-value adjustment is 500.00 − 500.00 = CAD 0.00 and posts no line.",
      "Goodwill is 550.00 − 500.00 = CAD 50.00; the investment eliminates at CAD 550.00.",
      "No NCI is recognised and no income is allocated: only the owned share is combined.",
    ],
    expected: {
      entries: [
        {
          step: "ownership consolidation",
          lines: [
            { role: "subsidiaryEquity", amount: "500.0000" },
            { role: "goodwill", amount: "50.0000" },
            { role: "investmentInSub", amount: "-550.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const childId = await addSubsidiary(ctx, "Joint Op Co", "CAD", "CA", false);
      await addSubsidiary(ctx, "Eliminations", "CAD", "CA", true);
      await postFixtureEntry(ctx, childId, "CONF-C4-CAP", "2026-07-01", "Opening equity", [
        { accountId: ctx.roles.bank, amount: "1000", currency: "CAD" },
        { accountId: ctx.roles.subsidiaryEquity, amount: "-1000", currency: "CAD" },
      ]);
      await postFixtureEntry(ctx, childId, "CONF-C4-PROFIT", ledger.date, "Period profit", [
        { accountId: ctx.roles.bank, amount: "100", currency: "CAD" },
        { accountId: ctx.roles.revenue, amount: "-100", currency: "CAD" },
      ]);
      await addOwnershipPolicy(ctx, {
        subsidiaryId: childId,
        ownershipPercent: "50",
        method: "proportionate",
        acquisitionDate: "2026-07-01",
        acquisitionCost: "550",
        fairValueNetAssets: "1000",
        acquisitionRate: "1",
      });
      const entry = await captureOwnership(ctx, "ownership consolidation");
      return { entries: [entry] };
    },
  },

  {
    id: "consol-foreign-sub-translation",
    title: "A foreign subsidiary translates profit at the average rate and equity at history",
    citations: [
      {
        standard: "IAS 21",
        reference: "IAS 21.39",
        kind: "requirement",
        requirement:
          "A foreign operation's income and expenses are translated at the exchange rates at the dates of the transactions while its equity history stays at historical rates, so each element moves at the rate proper to it.",
      },
      {
        standard: "ASC 830",
        reference: "ASC 830-30-45-3",
        kind: "requirement",
        requirement:
          "A foreign entity's income-statement elements are translated at a weighted-average rate for the period while balance-sheet translation uses the current rate, with equity carried at historical rates.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "An 80%-owned USD subsidiary with USD 1,000.00 of equity acquired when the policy rate was 1.30 eliminates at CAD 1,300.00, while its USD 100.00 profit translates at the period average of 1.3750 to CAD 137.50 — and the 20% NCI income of CAD 27.50 proves the average, not the spot, was applied.",
    facts: [
      "The reporting currency is CAD; the subsidiary keeps its books in USD.",
      "July spot rates are 1.3500 (5 July) and 1.4000 (25 July): the derived average is 1.3750 and the current rate is 1.4000.",
      "Acquisition-date equity of USD 1,000.00 at the policy acquisition rate of 1.30 eliminates at CAD 1,300.00 against a CAD 1,200.00 investment, with fair value of 1,400.00 giving a 100.00 adjustment, NCI of 280.00 and goodwill of 80.00.",
      "Period profit of USD 100.00 at the 1.3750 average is CAD 137.50; NCI income is 137.50 × 20% = CAD 27.50, leaving NCI equity at a 307.50 credit.",
    ],
    expected: {
      entries: [
        {
          step: "ownership consolidation",
          lines: [
            { role: "subsidiaryEquity", amount: "1300.0000" },
            { role: "fairValueAdjustment", amount: "100.0000" },
            { role: "goodwill", amount: "80.0000" },
            { role: "investmentInSub", amount: "-1200.0000" },
            { role: "nciEquity", amount: "-307.5000" },
            { role: "nciIncome", amount: "27.5000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const childId = await addSubsidiary(ctx, "US Sub Co", "USD", "US", false);
      await addSubsidiary(ctx, "Eliminations", "CAD", "CA", true);
      await postFixtureEntry(ctx, childId, "CONF-C5-CAP", "2026-07-01", "Opening equity", [
        { accountId: ctx.roles.bank, amount: "1000", currency: "USD" },
        { accountId: ctx.roles.subsidiaryEquity, amount: "-1000", currency: "USD" },
      ]);
      await postFixtureEntry(ctx, childId, "CONF-C5-PROFIT", ledger.date, "Period profit", [
        { accountId: ctx.roles.bank, amount: "100", currency: "USD" },
        { accountId: ctx.roles.revenue, amount: "-100", currency: "USD" },
      ]);
      await setSpotRate(ledger, "USD", "CAD", "2026-07-05", "1.35");
      await setSpotRate(ledger, "USD", "CAD", "2026-07-25", "1.40");
      await deriveConsolidatedRates(ledger.orgId, ledger.periodId, ledger.actorId);
      await addOwnershipPolicy(ctx, {
        subsidiaryId: childId,
        ownershipPercent: "80",
        method: "full",
        acquisitionDate: "2026-07-01",
        acquisitionCost: "1200",
        fairValueNetAssets: "1400",
        acquisitionRate: "1.30",
        nciEquityAccountId: ctx.roles.nciEquity,
        nciIncomeAccountId: ctx.roles.nciIncome,
      });
      const entry = await captureOwnership(ctx, "ownership consolidation");
      return { entries: [entry] };
    },
  },

  {
    id: "consol-loss-of-control",
    title: "Loss of control derecognises the subsidiary and remeasures any retained interest",
    citations: [
      {
        standard: "IFRS 10",
        reference: "IFRS 10.25",
        kind: "requirement",
        requirement:
          "When control is lost, the former parent derecognises the subsidiary's assets, liabilities and non-controlling interests, recognises any retained investment at fair value, and reclassifies related translation differences to profit or loss.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "Selling down from 80% to 20% removes the subsidiary's net assets and NCI from the consolidated balance sheet, books the retained 20% at its fair value, and recognises the resulting gain or loss with the accumulated translation difference reclassified out of equity.",
    facts: [
      "A parent sells 60% of an 80%-owned subsidiary, retaining 20% with significant influence.",
      "The subsidiary's consolidated net assets including goodwill are CAD 1,180.00 with NCI of CAD 280.00.",
      "The retained 20% has a fair value of CAD 400.00; proceeds for the 60% sold are CAD 1,200.00.",
      "The disposal gain is 1,200.00 + 400.00 − (1,180.00 − 280.00) = CAD 700.00.",
    ],
    gap:
      "The engine has no loss-of-control accounting: closing or narrowing an ownership policy simply stops future consolidation generations, leaving the parent's investment at cost with no derecognition of the subsidiary's net assets, no release of NCI, no fair-value remeasurement of any retained interest, and no reclassification of translation differences.",
    expected: {
      values: { disposalGain: "700.0000" },
    },
  },
];

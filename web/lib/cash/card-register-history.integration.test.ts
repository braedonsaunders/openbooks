import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { daysInCivilMonth } from "@openbooks/engine/src/platform/civil-date.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedPostingAccount,
} from "@openbooks/engine/src/testing/fixtures.ts";

const { forecastCategoryOrUnavailable } = await import("./core.ts");

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

const WEEKS = ["2026-08-23", "2026-08-30", "2026-09-06", "2026-09-13"];
const CONTEXT = { arWeekly: {}, apWeekly: {}, cashStart: "0.0000", subIds: undefined } as const;

async function seedAccount(org: ScratchOrg, name: string, type: string): Promise<string> {
  return seedPostingAccount(org.orgId, "2099", name, type);
}

async function seedPeriod(org: ScratchOrg, year: number, month: number): Promise<string> {
  const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${org.periodId}
  `)).rows[0]!.fiscal_calendar_id;
  const id = randomUUID();
  const mm = String(month).padStart(2, "0");
  const last = daysInCivilMonth(year, month);
  await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
    values (${id},${org.orgId},${year},${month},${`${year}-${mm}`},${`${year}-${mm}-01`},${`${year}-${mm}-${String(last).padStart(2, "0")}`},false,${cal})`);
  return id;
}

async function seedSubsidiary(org: ScratchOrg, name: string, currency: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${name}, ${currency}, 'DE')`);
  return id;
}

async function seedCharge(
  org: ScratchOrg,
  subsidiaryId: string,
  accountId: string,
  currency: string,
  postingDate: string,
  periodId: string,
  amount: string,
): Promise<void> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entry},${org.orgId},${org.bookId},${subsidiaryId},${entry},${postingDate},${periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values (${org.orgId},${entry},1,${accountId},${subsidiaryId},${`-${amount}`},${currency},${`-${amount}`},1),
      (${org.orgId},${entry},2,${org.accounts.adjustment},${subsidiaryId},${amount},${currency},${amount},1)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
}

/**
 * A card with no payment history and no configured threshold has no cycle
 * to forecast from: the category refuses by name (naming the category
 * editor as the remedy) with zeros behind it, instead of falling back to a
 * currency-blind 10000 that silently reports "30 days since last payment".
 */
test("a card with no history and no threshold refuses by name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const card = await withBypass(() => seedAccount(org, "Corp Card", "liability_card"));
    await withOrgContext(org.orgId, async () => {
      const category = await forecastCategoryOrUnavailable(
        org.orgId,
        { id: randomUUID(), name: "Corp Card", direction: "outflow", method: "credit_card_cycle", cardAccountIds: [card], historyMonths: 6 },
        "2026-09-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(category.unavailable?.code, "card-threshold-missing");
      assert.match(category.unavailable?.message ?? "", /category editor/);
      assert.deepEqual(category.weekly, ["0.0000", "0.0000", "0.0000", "0.0000"]);
      assert.equal(category.total, "0.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * A history leg whose functional currency has no rate on or before its date
 * refuses with the missing rate named — the category reports unavailable
 * instead of accruing the leg at zero.
 */
test("a history leg with no rate refuses with the missing rate named", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const card = await withBypass(() => seedAccount(org, "Corp Card", "liability_card"));
    await withBypass(async () => {
      const eu = await seedSubsidiary(org, "EU Co", "EUR");
      // The EUR row is org-shared reference data that parallel tests seed
      // too: the conflict branch is expected and benign (same code row),
      // so it stays instead of failing the seed.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('EUR', 'Euro', 2) on conflict (code) do nothing`);
      await seedCharge(org, eu, card, "EUR", "2026-07-15", org.periodId, "100");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await forecastCategoryOrUnavailable(
        org.orgId,
        { id: randomUUID(), name: "Corp Card", direction: "outflow", method: "credit_card_cycle", cardAccountIds: [card], historyMonths: 6, significantPaymentThreshold: "1" },
        "2026-09-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(category.unavailable?.code, "missing-exchange-rate");
      assert.match(category.unavailable?.message ?? "", /no spot rate for EUR→CAD/);
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * Card balances translate each functional at the forecast date before
 * adding: a 200 CAD charge in Main Co and a 100 EUR charge in EU Co (spot
 * 1.5) read as 350 in presentation currency, not 300. The threshold is
 * configured so the cycle has something to count as the last payment.
 */
test("card balances translate each functional before adding", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const card = await withBypass(() => seedAccount(org, "Corp Card", "liability_card"));
    await withBypass(async () => {
      const eu = await seedSubsidiary(org, "EU Co", "EUR");
      // Same org-shared EUR row as above: parallel seeds converge here.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('EUR', 'Euro', 2) on conflict (code) do nothing`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'EUR', 'CAD', '2026-06-01'::date, 'spot', 1.5, 'manual')`);
      await seedCharge(org, org.subsidiaryId, card, "CAD", "2026-07-15", org.periodId, "200");
      await seedCharge(org, eu, card, "EUR", "2026-07-15", org.periodId, "100");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await forecastCategoryOrUnavailable(
        org.orgId,
        { id: randomUUID(), name: "Corp Card", direction: "outflow", method: "credit_card_cycle", cardAccountIds: [card], historyMonths: 6, significantPaymentThreshold: "1" },
        "2026-09-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(category.unavailable, undefined, "a translated card forecasts instead of refusing");
      assert.equal(
        category.meta.currentBalance,
        "350.0000",
        "the balance reads in presentation currency (200 CAD + 100 EUR @ 1.5), never the raw 300",
      );
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * Register outflows translate each functional at their day before
 * averaging: a 1200 CAD outflow in Main Co and a 100 EUR outflow in EU Co
 * (spot 1.5) average as 112.50 a week over the 12-week window, not 108.33.
 */
test("register outflows translate each functional before averaging", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      const eu = await seedSubsidiary(org, "EU Co", "EUR");
      // Same org-shared EUR row as above: parallel seeds converge here.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('EUR', 'Euro', 2) on conflict (code) do nothing`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'EUR', 'CAD', '2026-06-01'::date, 'spot', 1.5, 'manual')`);
      // An April leg outside the 12-week window establishes old books so the
      // window spans the full twelve weeks, exactly like the register test.
      const april = await seedPeriod(org, 2026, 4);
      await seedCharge(org, org.subsidiaryId, org.accounts.bank, "CAD", "2026-04-20", april, "100");
      await seedCharge(org, org.subsidiaryId, org.accounts.bank, "CAD", "2026-07-15", org.periodId, "1200");
      await seedCharge(org, eu, org.accounts.bank, "EUR", "2026-07-15", org.periodId, "100");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await forecastCategoryOrUnavailable(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "bank_register_history", bankAccountIds: [org.accounts.bank], historyWeeks: 12, includeJournals: true },
        "2026-09-20",
        ["2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11"],
        { ...CONTEXT },
      );
      assert.equal(category.unavailable, undefined, "a translated register forecasts instead of refusing");
      assert.equal(category.meta.weeksUsed, 12);
      assert.equal(
        category.meta.rawAverage,
        "112.5000",
        "the window average reads in presentation currency (1200 CAD + 100 EUR @ 1.5 over 12 weeks)",
      );
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

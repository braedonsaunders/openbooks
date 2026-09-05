import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { disposeAsset, remeasureAsset } from "./asset-lifecycle.ts";
import { db } from "./db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { toUnits } from "./money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setFramework(orgId: string, framework: "us_gaap" | "ifrs"): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({ reportingFramework: framework })}::jsonb
     where id = ${orgId}`);
}

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed')
     where l.org_id = ${orgId} and l.account_id = ${accountId}`));
  return toUnits(r.rows[0]!.bal);
}

/** Nine open months beyond the seeded July period, so a ten-month life leaves unposted lines to rebuild. */
const FUTURE_PERIODS: readonly [number, number, string, string, string][] = [
  [2026, 8, "2026-08", "2026-08-01", "2026-08-31"],
  [2026, 9, "2026-09", "2026-09-01", "2026-09-30"],
  [2026, 10, "2026-10", "2026-10-01", "2026-10-31"],
  [2026, 11, "2026-11", "2026-11-01", "2026-11-30"],
  [2026, 12, "2026-12", "2026-12-01", "2026-12-31"],
  [2027, 1, "2027-01", "2027-01-01", "2027-01-31"],
  [2027, 2, "2027-02", "2027-02-01", "2027-02-28"],
  [2027, 3, "2027-03", "2027-03-01", "2027-03-31"],
  [2027, 4, "2027-04", "2027-04-01", "2027-04-30"],
];

/** Asset at cost 1,000, one month of depreciation (100) posted → NBV 900. */
async function seedDepreciatedAsset(
  org: ScratchOrg,
  actorId: string,
  opts: { futurePeriods?: boolean } = {},
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id,
       default_method, default_life_months, default_convention,
       tax_attributes, is_active, created_by, updated_by)
    values (${categoryId}, ${org.orgId}, 'Restoration equipment',
            ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, ${org.accounts.adjustment},
            'straight_line', 10, 'full_month', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
            ${`ASSET-${assetId.slice(0, 8)}`}, 'Restoration asset', 'in_service',
            ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
            'full_month', '{}'::jsonb, ${actorId}, ${actorId})`);
  if (opts.futurePeriods) {
    const calendarId = (
      await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods
         where org_id = ${org.orgId} limit 1`)
    ).rows[0]!.id;
    for (const [fiscalYear, periodNumber, name, startsOn, endsOn] of FUTURE_PERIODS) {
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
           is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, ${fiscalYear}, ${periodNumber},
                ${name}, ${startsOn}, ${endsOn}, false, ${calendarId})`);
    }
  }
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  const depreciation = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
  assert.equal(depreciation.totalAmount, "100.0000");
  return assetId;
}

test(
  "US GAAP prohibits restoring an impairment; IFRS reverses it capped at the unreversed loss",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const assetId = await seedDepreciatedAsset(org, actorId);

      // Impair NBV 900 → 750 (loss 150) under US GAAP.
      await setFramework(org.orgId, "us_gaap");
      const impairment = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "750",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-150.0000");

      // Fair value recovers: ANY write-up is a prohibited restoration.
      await assert.rejects(
        remeasureAsset(org.orgId, assetId, { newCarryingValue: "820", date: "2026-07-31", actorId }),
        /US GAAP prohibits restoring/,
      );
      // Further impairment remains permitted.
      const deeper = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "700",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(deeper.delta, "-50.0000");

      // The second remeasure measured off the IMPAIRED carrying amount (750),
      // not the schedule-only NBV (900): total unreversed impairment is 200.
      await setFramework(org.orgId, "ifrs");
      // IFRS: reversal permitted up to the unreversed impairment (cap 200 →
      // carrying may return to at most 900). 700 → 850 releases 150.
      const reversal = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "850",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(reversal.delta, "150.0000");
      // Beyond depreciated historical cost (900) is refused: 850 → 950 asks
      // for 100 against the remaining 50 of unreversed impairment.
      await assert.rejects(
        remeasureAsset(org.orgId, assetId, { newCarryingValue: "950", date: "2026-07-31", actorId }),
        /IAS 36 caps an impairment reversal/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "disposal after impairment clears accumulated depreciation exactly — no stranded credit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const assetId = await seedDepreciatedAsset(org, actorId);

      // Impair 900 → 750: accumulated-depreciation account now carries
      // 100 (schedule) + 150 (impairment) = 250 credit.
      await remeasureAsset(org.orgId, assetId, { newCarryingValue: "750", date: "2026-07-31", actorId });
      assert.equal(await glBalance(org.orgId, org.accounts.clearing), -toUnits("250"));

      // Sell for 800: NBV must be 750 (not 900), gain 50, and derecognition
      // must remove the WHOLE 250 from accumulated depreciation.
      const disposal = await disposeAsset(org.orgId, assetId, {
        proceeds: "800",
        proceedsAccountId: org.accounts.bank,
        date: "2026-07-31",
        actorId,
      });
      assert.equal(disposal.nbv, "750.0000");
      assert.equal(disposal.gainLoss, "50.0000");
      // The whole 250 credit left the accumulated-depreciation account.
      assert.equal(await glBalance(org.orgId, org.accounts.clearing), 0n);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "future depreciation rebases onto the latest carrying value; a refused remeasurement writes nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const assetId = await seedDepreciatedAsset(org, actorId, { futurePeriods: true });

      // The whole remeasurement evidence surface: schedule lines (posted and
      // future), lifecycle events, and revaluation journals.
      const evidence = async () => ({
        lines: (await db.execute<{ sequence: number; planned: string; posted: string | null }>(sql`
          select l.sequence, l.planned_amount::text as planned, l.posted_amount::text as posted
            from depreciation_schedule_lines l
            join depreciation_schedules s
              on s.id = l.schedule_id and s.org_id = l.org_id
           where s.org_id = ${org.orgId} and s.asset_id = ${assetId}
             and s.book_id = ${org.bookId}
           order by l.sequence`)).rows,
        events: (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from asset_events
           where org_id = ${org.orgId} and asset_id = ${assetId}`)).rows,
        journals: (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from journal_entries
           where org_id = ${org.orgId} and origin = 'revaluation'`)).rows,
      });
      const futurePlanned = async () =>
        (await evidence()).lines.filter((line) => line.posted === null).map((line) => line.planned);

      // Impair NBV 900 → 750 under US GAAP.
      await setFramework(org.orgId, "us_gaap");
      const impairment = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "750",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-150.0000");
      // All nine unposted lines rebase onto the impaired basis (750 − 0
      // salvage straight-line); the posted July history is untouched.
      assert.deepEqual(await futurePlanned(), [
        ...Array.from({ length: 8 }, () => "83.3333"),
        "83.3336",
      ]);
      let snapshot = await evidence();
      assert.equal(snapshot.lines.find((line) => line.sequence === 0)!.posted, "100.0000");
      assert.deepEqual(snapshot.events, [{ n: 1 }]);
      assert.deepEqual(snapshot.journals, [{ n: 1 }]);

      // A prohibited US GAAP restoration must not touch ANYTHING.
      await assert.rejects(
        remeasureAsset(org.orgId, assetId, { newCarryingValue: "820", date: "2026-07-31", actorId }),
        /US GAAP prohibits restoring/,
      );
      assert.deepEqual(await evidence(), snapshot, "a refused remeasurement writes nothing");

      // Further impairment remains permitted and rebases the future lines again.
      const deeper = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "700",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(deeper.delta, "-50.0000");
      snapshot = await evidence();
      assert.deepEqual(await futurePlanned(), [
        ...Array.from({ length: 8 }, () => "77.7777"),
        "77.7784",
      ]);
      assert.equal(snapshot.lines.find((line) => line.sequence === 0)!.posted, "100.0000");
      assert.deepEqual(snapshot.events, [{ n: 2 }]);
      assert.deepEqual(snapshot.journals, [{ n: 2 }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  disposeAsset,
  remeasureAsset,
  reverseAssetLifecycleEvent,
} from "./asset-lifecycle.ts";
import { db } from "./db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

async function quietly(statement: string): Promise<void> {
  try {
    await db.execute(sql.raw(statement));
  } catch {
    // Failure-injector cleanup must never mask the test's own result.
  }
}

test(
  "asset remeasurement and disposal use exact append-only, idempotent reversals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const assetId = randomUUID();
    try {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Lifecycle equipment',
           ${org.accounts.invAsset}, ${org.accounts.clearing},
           ${org.accounts.adjustment}, ${org.accounts.adjustment},
           'straight_line', 10, 'full_month', '{}'::jsonb, true,
           ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status,
           acquired_on, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, useful_life_months, depreciation_convention,
           custom, created_by, updated_by)
        values
          (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
           'ASSET-LIFECYCLE', 'Lifecycle asset', 'in_service',
           ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const depreciation = await runDepreciation(
        org.orgId,
        "2026-07-31",
        actorId,
        assetId,
      );
      assert.equal(depreciation.posted, 1);
      assert.equal(depreciation.totalAmount, "100.0000");

      const impairment = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "800",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-100.0000");
      const impairmentEvent = (await db.execute<{ id: string }>(sql`
        select id from asset_events
         where org_id = ${org.orgId}
           and asset_id = ${assetId}
           and journal_entry_id = ${impairment.entryId}
      `));
      const impairmentEntryBefore = await db.execute(sql`
        select id, line_number, account_id, amount::text, txn_amount::text
          from journal_lines
         where entry_id = ${impairment.entryId}
         order by line_number
      `);
      const impairmentReversal = await reverseAssetLifecycleEvent(
        org.orgId,
        impairmentEvent.rows[0]!.id,
        {
          date: "2026-07-31",
          actorId,
          reason: "Controller reversed the impairment test",
        },
      );
      assert.equal(impairmentReversal.created, true);
      assert.equal(impairmentReversal.restoredStatus, null);
      const impairmentEntryAfter = await db.execute(sql`
        select id, line_number, account_id, amount::text, txn_amount::text
          from journal_lines
         where entry_id = ${impairment.entryId}
         order by line_number
      `);
      assert.deepEqual(
        impairmentEntryAfter.rows,
        impairmentEntryBefore.rows,
        "remeasurement journal remains immutable",
      );

      const disposal = await disposeAsset(org.orgId, assetId, {
        writeOff: true,
        date: "2026-07-31",
        actorId,
      });
      assert.equal(disposal.status, "written_off");
      assert.equal(disposal.nbv, "900.0000");
      const disposalEvent = (await db.execute<{ id: string }>(sql`
        select id from asset_events
         where org_id = ${org.orgId}
           and asset_id = ${assetId}
           and journal_entry_id = ${disposal.entryId}
      `));
      const disposalRuns = await Promise.all([
        reverseAssetLifecycleEvent(org.orgId, disposalEvent.rows[0]!.id, {
          date: "2026-07-31",
          actorId,
          reason: "Controller restored the scrapped asset",
        }),
        reverseAssetLifecycleEvent(org.orgId, disposalEvent.rows[0]!.id, {
          date: "2026-07-31",
          actorId,
          reason: "Controller restored the scrapped asset",
        }),
      ]);
      assert.equal(
        new Set(disposalRuns.map((run) => run.reversalEntryId)).size,
        1,
      );
      assert.deepEqual(
        disposalRuns.map((run) => run.created).sort(),
        [false, true],
      );

      const evidence = (await db.execute<{
          status: string;
          sources: number;
          reversals: number;
          reversal_entries: number;
          lifecycle_net: string;
        }>(sql`
        select asset.status,
               count(distinct event.id) filter (
                 where event.kind in ('impaired', 'written_off')
               )::int as sources,
               count(distinct event.id) filter (
                 where event.kind = 'reversed'
               )::int as reversals,
               count(distinct reversal_entry.id)::int as reversal_entries,
               coalesce(sum(line.amount), 0)::text as lifecycle_net
          from fixed_assets asset
          join asset_events event on event.asset_id = asset.id
          left join journal_entries reversal_entry
            on reversal_entry.id = event.journal_entry_id
           and event.kind = 'reversed'
          left join journal_lines line
            on line.entry_id in (
              select journal_entry_id from asset_events
               where asset_id = asset.id
                 and kind in ('impaired', 'written_off', 'reversed')
            )
         where asset.id = ${assetId}
         group by asset.id
      `));
      assert.deepEqual(evidence.rows, [
        {
          status: "in_service",
          sources: 2,
          reversals: 2,
          reversal_entries: 2,
          lifecycle_net: "0.0000",
        },
      ]);

      await assert.rejects(
        db.execute(sql`
          update asset_events
             set reversal_reason = 'tampered evidence'
           where id = ${impairmentReversal.reversalEventId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /asset lifecycle evidence is append-only/),
      );
      const retry = await reverseAssetLifecycleEvent(
        org.orgId,
        impairmentEvent.rows[0]!.id,
        {
          date: "2026-07-31",
          actorId,
          reason: "Controller reversed the impairment test",
        },
      );
      assert.equal(retry.created, false);
      assert.equal(
        retry.reversalEntryId,
        impairmentReversal.reversalEntryId,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a mid-rebuild failure rolls the remeasurement journal, event, and future schedule back together",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const assetId = randomUUID();
    // Unique per run: the injector is org-scoped, but its catalog objects are
    // global, so a fresh name keeps parallel suites and reruns isolated.
    const guard = `remeasure_rebuild_guard_${randomUUID().replaceAll("-", "")}`;
    const scheduleLines = () =>
      db.execute<{ sequence: number; planned: string; posted: string | null }>(sql`
        select l.sequence, l.planned_amount::text as planned, l.posted_amount::text as posted
          from depreciation_schedule_lines l
          join depreciation_schedules s
            on s.id = l.schedule_id and s.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.asset_id = ${assetId}
           and s.book_id = ${org.bookId}
         order by l.sequence`);
    try {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Remeasurement rollback equipment',
           ${org.accounts.invAsset}, ${org.accounts.clearing},
           ${org.accounts.adjustment}, ${org.accounts.adjustment},
           'straight_line', 10, 'full_month', '{}'::jsonb, true,
           ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status,
           acquired_on, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, useful_life_months, depreciation_convention,
           custom, created_by, updated_by)
        values
          (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
           'ASSET-ROLLBACK', 'Rollback asset', 'in_service',
           ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      // Open the nine months beyond July that a ten-month life spans, so the
      // built schedule carries unposted lines — exactly the surface the
      // remeasurement rebuild rewrites.
      const calendarId = (
        await db.execute<{ id: string }>(sql`
          select fiscal_calendar_id as id from accounting_periods
           where org_id = ${org.orgId} limit 1`)
      ).rows[0]!.id;
      const futurePeriods: [number, number, string, string, string][] = [
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
      for (const [fiscalYear, periodNumber, name, startsOn, endsOn] of futurePeriods) {
        await db.execute(sql`
          insert into accounting_periods
            (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
             is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, ${fiscalYear}, ${periodNumber},
                  ${name}, ${startsOn}, ${endsOn}, false, ${calendarId})`);
      }
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const depreciation = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
      assert.equal(depreciation.posted, 1);
      assert.equal(depreciation.totalAmount, "100.0000");

      const before = (await scheduleLines()).rows;
      assert.equal(before.length, 10);
      assert.equal(before.filter((line) => line.posted === null).length, 9);

      // Failure injector: while armed for this scratch org only, the third
      // rebuilt schedule line raises mid-transaction.
      await db.execute(sql.raw(`create sequence "${guard}_seq"`));
      await db.execute(sql.raw(`
        create function "${guard}"() returns trigger language plpgsql as $fn$
        begin
          if nextval('${guard}_seq') >= 3 then
            raise exception 'forced mid-rebuild failure';
          end if;
          return new;
        end
        $fn$`));
      await db.execute(sql.raw(`
        create trigger "${guard}_trg"
          before update of planned_amount on depreciation_schedule_lines
          for each row
          when (new.org_id = '${org.orgId}' and old.posted_amount is null
                and old.planned_amount is distinct from new.planned_amount)
          execute function "${guard}"()`));

      await assert.rejects(
        remeasureAsset(org.orgId, assetId, {
          newCarryingValue: "800",
          date: "2026-07-31",
          actorId,
        }),
        (error: unknown) => errorChainMatches(error, /forced mid-rebuild failure/),
      );
      assert.deepEqual(
        (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from journal_entries
           where org_id = ${org.orgId} and origin = 'revaluation'`)).rows,
        [{ n: 0 }],
        "no remeasurement journal may survive a failed schedule rebuild",
      );
      assert.deepEqual(
        (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from asset_events
           where org_id = ${org.orgId} and asset_id = ${assetId}`)).rows,
        [{ n: 0 }],
        "no asset event may survive a failed schedule rebuild",
      );
      assert.deepEqual(
        (await scheduleLines()).rows,
        before,
        "a failed rebuild must leave every schedule line untouched — no old or partial state",
      );

      // Recovery: without the injector the same remeasurement succeeds and
      // rebases all nine future lines onto the impaired carrying value.
      await quietly(`drop trigger if exists "${guard}_trg" on depreciation_schedule_lines`);
      await quietly(`drop function if exists "${guard}"()`);
      await quietly(`drop sequence if exists "${guard}_seq"`);
      const recovery = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "800",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(recovery.kind, "impaired");
      assert.equal(recovery.delta, "-100.0000");
      assert.equal(recovery.rebuiltLines, 9);
      const rebuilt = (await scheduleLines()).rows;
      assert.deepEqual(
        rebuilt.filter((line) => line.posted === null).map((line) => line.planned),
        [...Array.from({ length: 8 }, () => "88.8888"), "88.8896"],
        "future depreciation runs straight-line off the impaired basis with an exact remainder",
      );
      assert.equal(rebuilt.find((line) => line.sequence === 0)!.posted, "100.0000");
      const recoveryEntry = (await db.execute<{ status: string; origin: string }>(sql`
        select status, origin from journal_entries where id = ${recovery.entryId}`)).rows;
      assert.deepEqual(recoveryEntry, [{ status: "posted", origin: "revaluation" }]);
      assert.deepEqual(
        (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from asset_events
           where org_id = ${org.orgId} and asset_id = ${assetId}
             and kind = 'impaired' and journal_entry_id = ${recovery.entryId}`)).rows,
        [{ n: 1 }],
      );
    } finally {
      await quietly(`drop trigger if exists "${guard}_trg" on depreciation_schedule_lines`);
      await quietly(`drop function if exists "${guard}"()`);
      await quietly(`drop sequence if exists "${guard}_seq"`);
      await dropScratchOrg(org.orgId);
    }
  },
);

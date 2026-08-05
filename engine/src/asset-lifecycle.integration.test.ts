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
        date: org.date,
        actorId,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-100.0000");
      const impairmentEvent = (await db.execute(sql`
        select id from asset_events
         where org_id = ${org.orgId}
           and asset_id = ${assetId}
           and journal_entry_id = ${impairment.entryId}
      `)) as unknown as { rows: { id: string }[] };
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
          date: org.date,
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
        date: org.date,
        actorId,
      });
      assert.equal(disposal.status, "written_off");
      assert.equal(disposal.nbv, "900.0000");
      const disposalEvent = (await db.execute(sql`
        select id from asset_events
         where org_id = ${org.orgId}
           and asset_id = ${assetId}
           and journal_entry_id = ${disposal.entryId}
      `)) as unknown as { rows: { id: string }[] };
      const disposalRuns = await Promise.all([
        reverseAssetLifecycleEvent(org.orgId, disposalEvent.rows[0]!.id, {
          date: org.date,
          actorId,
          reason: "Controller restored the scrapped asset",
        }),
        reverseAssetLifecycleEvent(org.orgId, disposalEvent.rows[0]!.id, {
          date: org.date,
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

      const evidence = (await db.execute(sql`
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
      `)) as unknown as {
        rows: Array<{
          status: string;
          sources: number;
          reversals: number;
          reversal_entries: number;
          lifecycle_net: string;
        }>;
      };
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
          date: org.date,
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

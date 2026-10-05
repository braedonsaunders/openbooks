import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { addCalendarDays, mondayOfIsoWeek } from "../platform/civil-date.ts";
import { cmp } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import {
  confirmPlanSuggestion,
  convertTransferSuggestion,
  forecastAccuracy,
  getDemandRun,
  groupSuggestionsBySupplier,
  listDemandRuns,
  listPlanSuggestions,
  markBuySuggestionConverted,
  runDemandPlan,
  saveDemandPolicy,
  saveForecastOverride,
  DemandPlanningError,
  type DemandPlanRun,
} from "./demand-planning.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const AS_OF = "2026-07-15";
const GRID = [0, 1, 2, 3, 4, 5, 6, 7].map((back) =>
  addCalendarDays(mondayOfIsoWeek(AS_OF), -(7 - back) * 7),
);

type Fixture = { org: ScratchOrg; actorId: string };

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await withBypassContext(async () => {
    const enabled = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"demandPlanning":true}'::jsonb) where id=${org.orgId} returning id`);
    assert.equal(enabled.rows.length, 1);
    const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`)).rows[0]!.fiscal_calendar_id;
    // Transfer orders resolve their transit default up front, so the
    // fixture carries a transit location like the movement fence suite.
    const transit = await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active)
      values(${randomUUID()},${org.orgId},${org.locationId},'PLAN-TRANSIT','transit',true) returning id`);
    assert.equal(transit.rows.length, 1);
    for (const [number, name, start, end] of [
      [5, "2026-05", "2026-05-01", "2026-05-31"],
      [6, "2026-06", "2026-06-01", "2026-06-30"],
    ] as const) {
      const seeded = await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, 2026, ${number}, ${name}, ${start}, ${end}, false, ${cal}) returning id`);
      assert.equal(seeded.rows.length, 1);
    }
  });
  return { org, actorId };
}

async function receive(f: Fixture, itemId: string, location: string, quantity: string, date: string) {
  await receiveInventory(f.org.orgId, f.actorId, {
    itemId,
    stockLocationId: location,
    subsidiaryId: f.org.subsidiaryId,
    quantity,
    unitCost: "5",
    date,
    offsetAccountId: f.org.accounts.clearing,
  });
}

async function issueWeekly(f: Fixture, itemId: string, location: string, quantity: string) {
  for (const day of GRID) {
    await issueInventory(f.org.orgId, f.actorId, {
      itemId,
      stockLocationId: location,
      subsidiaryId: f.org.subsidiaryId,
      quantity,
      date: day,
    });
  }
}

async function seed(f: Fixture) {
  const main = f.org.stockLocationId;
  const dc = f.org.stockLocationId2;
  await receive(f, f.org.items.fifo, main, "90", "2026-05-20");
  await issueWeekly(f, f.org.items.fifo, main, "10");
  await receive(f, f.org.items.component, main, "90", "2026-05-20");
  await issueWeekly(f, f.org.items.component, main, "10");
  await receive(f, f.org.items.component, dc, "200", "2026-05-20");
  await issueWeekly(f, f.org.items.component, dc, "10");
  await receive(f, f.org.items.standard, main, "45", "2026-05-20");
  await issueWeekly(f, f.org.items.standard, main, "5");
  await withBypassContext(() => withOrgTransaction(f.org.orgId, async () => {
    await saveDemandPolicy(db, f.org.orgId, f.actorId, {
      itemId: f.org.items.fifo, leadTimeDays: 7, reviewCycleDays: 7, serviceLevel: "0.95",
      moqQty: null, casePackQty: "12", preferredSupplierId: f.org.vendorId,
      forecastMethod: "auto", historyWeeks: null,
    });
    await saveDemandPolicy(db, f.org.orgId, f.actorId, {
      itemId: f.org.items.component, leadTimeDays: 7, reviewCycleDays: 7, serviceLevel: "0.95",
      moqQty: null, casePackQty: null, preferredSupplierId: null,
      forecastMethod: "auto", historyWeeks: null,
    });
    await saveDemandPolicy(db, f.org.orgId, f.actorId, {
      itemId: f.org.items.standard, leadTimeDays: 7, reviewCycleDays: 7, serviceLevel: "0.95",
      moqQty: "30", casePackQty: null, preferredSupplierId: f.org.vendorId,
      forecastMethod: "auto", historyWeeks: null,
    });
  }));
}

function run(f: Fixture, idempotencyKey?: string): Promise<DemandPlanRun> {
  return withBypassContext(() => withOrgTransaction(f.org.orgId, async () =>
    runDemandPlan(db, f.org.orgId, f.actorId, {
      subsidiaryId: f.org.subsidiaryId, asOf: AS_OF, horizonWeeks: 4, historyWeeks: 8, idempotencyKey,
    }),
  ));
}

test("suggestion equals forecast over lead plus review plus safety minus projected supply, sized to the case pack", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    const planned = await run(f);
    assert.equal(planned.status, "complete");
    const suggestions = await withBypassContext(() => listPlanSuggestions(db, f.org.orgId, f.org.subsidiaryId));
    const buy = suggestions.find((row) => row.itemId === f.org.items.fifo && row.action === "buy");
    assert.ok(buy, "expected a buy suggestion for the fifo item");
    // Cover is two weeks at ten a week with no variance; ten short rounds
    // up to the case pack of twelve.
    assert.equal(buy.quantity, "12.0000");
    assert.equal(buy.forecastQty, "20.0000");
    assert.equal(buy.projectedSupply, "10.0000");
    assert.ok(buy.daysOfCover !== null && cmp(buy.daysOfCover, "6.9") > 0 && cmp(buy.daysOfCover, "7.1") < 0);
    assert.equal(buy.supplierId, f.org.vendorId);
    const detail = await withBypassContext(() => getDemandRun(db, f.org.orgId, f.org.subsidiaryId, planned.id));
    assert.equal(detail.forecasts.length, 4 * 4);
    const fifoForecasts = detail.forecasts.filter(
      (row) => (row as { itemId: string }).itemId === f.org.items.fifo,
    );
    assert.equal(fifoForecasts.length, 4);
    assert.ok(fifoForecasts.every((row) => (row as { quantity: string }).quantity === "10.0000"));
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("a surplus location covers a short one by transfer before anything is bought", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    await run(f);
    const suggestions = await withBypassContext(() => listPlanSuggestions(db, f.org.orgId, f.org.subsidiaryId));
    const component = suggestions.filter((row) => row.itemId === f.org.items.component);
    const transfer = component.find((row) => row.action === "transfer");
    assert.ok(transfer, "expected a transfer suggestion for the component item");
    assert.equal(transfer.quantity, "10.0000");
    assert.equal(transfer.stockLocationId, f.org.stockLocationId);
    assert.ok(!component.some((row) => row.action === "buy"), "no purchase while a transfer covers the need");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("buy suggestions group by supplier and convert exactly once", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    await run(f);
    const suggestions = await withBypassContext(() => listPlanSuggestions(db, f.org.orgId, f.org.subsidiaryId));
    const buys = suggestions.filter((row) => row.action === "buy");
    assert.equal(buys.length, 2);
    const groups = groupSuggestionsBySupplier(buys);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.supplierId, f.org.vendorId);
    assert.deepEqual(
      groups[0]!.suggestions.map((row) => row.itemId).sort(),
      [f.org.items.fifo, f.org.items.standard].sort(),
    );
    const standard = buys.find((row) => row.itemId === f.org.items.standard)!;
    // Five short against a minimum order of thirty buys thirty.
    assert.equal(standard.quantity, "30.0000");
    await withBypassContext(() => withOrgTransaction(f.org.orgId, async () => {
      await confirmPlanSuggestion(db, f.org.orgId, f.actorId, standard.id);
    }));
    const draftId = randomUUID();
    const first = await withBypassContext(() => withOrgTransaction(f.org.orgId, async () =>
      markBuySuggestionConverted(db, f.org.orgId, f.actorId, standard.id, draftId)));
    assert.equal(first.replayed, false);
    const replay = await withBypassContext(() => withOrgTransaction(f.org.orgId, async () =>
      markBuySuggestionConverted(db, f.org.orgId, f.actorId, standard.id, draftId)));
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, draftId);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("a transfer suggestion converts to a transfer order at the surplus source", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    await run(f);
    const suggestions = await withBypassContext(() => listPlanSuggestions(db, f.org.orgId, f.org.subsidiaryId));
    const transfer = suggestions.find((row) => row.itemId === f.org.items.component && row.action === "transfer")!;
    assert.ok(transfer);
    await withBypassContext(() => withOrgTransaction(f.org.orgId, async () => {
      await confirmPlanSuggestion(db, f.org.orgId, f.actorId, transfer.id);
      const converted = await convertTransferSuggestion(db, f.org.orgId, f.actorId, transfer.id, {
        fromStockLocationId: f.org.stockLocationId2,
      });
      assert.equal(converted.action, "transfer");
      assert.equal(converted.replayed, false);
      const replayed = await convertTransferSuggestion(db, f.org.orgId, f.actorId, transfer.id, {
        fromStockLocationId: f.org.stockLocationId2,
      });
      assert.equal(replayed.replayed, true);
    }));
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("an override replaces the model for its week and the rerun supersedes", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    const first = await run(f);
    await withBypassContext(() => withOrgTransaction(f.org.orgId, async () => {
      await saveForecastOverride(db, f.org.orgId, f.actorId, {
        itemId: f.org.items.fifo,
        stockLocationId: f.org.stockLocationId,
        periodStart: GRID[0]!,
        quantity: "99",
        reason: "a confirmed customer order lands that week",
      });
    }));
    // The override targets a history Monday, outside any horizon: saving it
    // must still succeed, but no forecast row may carry it.
    const horizonStart = addCalendarDays(mondayOfIsoWeek(AS_OF), 7);
    await withBypassContext(() => withOrgTransaction(f.org.orgId, async () => {
      await saveForecastOverride(db, f.org.orgId, f.actorId, {
        itemId: f.org.items.fifo,
        stockLocationId: f.org.stockLocationId,
        periodStart: horizonStart,
        quantity: "99",
        reason: "a confirmed customer order lands that week",
      });
    }));
    const second = await run(f);
    const detail = await withBypassContext(() => getDemandRun(db, f.org.orgId, f.org.subsidiaryId, second.id));
    const overridden = detail.forecasts.find((row) => {
      const typed = row as { itemId: string; periodStart: string; method: string; quantity: string };
      return typed.itemId === f.org.items.fifo && typed.periodStart === horizonStart;
    }) as unknown as { method: string; quantity: string };
    assert.ok(overridden);
    assert.equal(overridden.method, "override");
    assert.equal(overridden.quantity, "99.0000");
    const runs = await withBypassContext(() => listDemandRuns(db, f.org.orgId, f.org.subsidiaryId));
    assert.equal(runs.find((row) => row.id === first.id)!.status, "superseded");
    assert.equal(runs.find((row) => row.id === second.id)!.status, "complete");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("a repeated idempotency key replays the stored run instead of planning twice", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    const key = randomUUID();
    const first = await run(f, key);
    assert.equal(first.replayed, false);
    const replay = await run(f, key);
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, first.id);
    const count = await withBypassContext(async () => (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from demand_forecast_runs where org_id = ${f.org.orgId}`)).rows[0]!.count);
    assert.equal(count, "1");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("a disabled demandPlanning gate refuses the run, the policy save and the read", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    await withBypassContext(async () => {
      const disabled = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"demandPlanning":false}'::jsonb) where id=${f.org.orgId} returning id`);
      assert.equal(disabled.rows.length, 1);
    });
    await assert.rejects(
      run(f),
      (error: unknown) => error instanceof DemandPlanningError
        && error.code === "demand_planning_disabled"
        && error.message.includes("Company Settings → Features"),
    );
    await assert.rejects(
      withBypassContext(() => listPlanSuggestions(db, f.org.orgId, f.org.subsidiaryId)),
      (error: unknown) => error instanceof DemandPlanningError && error.code === "demand_planning_disabled",
    );
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("forecast accuracy compares past forecasts against actual issues by item class", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await seed(f);
    // A scored past: the seeded grid sold ten a week while an older run
    // forecast twelve, so the class row must read a 20% miss and bias.
    const runId = randomUUID();
    await withBypassContext(async () => {
      const inserted = await db.execute(sql`
        insert into demand_forecast_runs
          (id, org_id, number, as_of, horizon_weeks, parameters, status, run_by, ran_at, created_by, updated_by)
        values (${runId}, ${f.org.orgId}, 'DFP-000001', '2026-05-01', 8,
          ${JSON.stringify({ subsidiaryId: f.org.subsidiaryId })}::jsonb,
          'complete', ${f.actorId}, now(), ${f.actorId}, ${f.actorId}) returning id`);
      assert.equal(inserted.rows.length, 1);
      for (const day of GRID) {
        const row = await db.execute(sql`
          insert into demand_forecasts
            (org_id, run_id, item_id, stock_location_id, period_start, period_grain,
             forecast_qty, lower_qty, upper_qty, method, explanation, created_by, updated_by)
          values (${f.org.orgId}, ${runId}, ${f.org.items.fifo}, ${f.org.stockLocationId},
            ${day}::date, 'week', '12', '10', '14', 'moving_average', '{}'::jsonb,
            ${f.actorId}, ${f.actorId}) returning id`);
        assert.equal(row.rows.length, 1);
      }
    });
    const rows = await withBypassContext(() => forecastAccuracy(db, f.org.orgId, f.org.subsidiaryId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.periods, 8);
    assert.ok(rows[0]!.mape !== null && cmp(rows[0]!.mape!, "0.19") > 0 && cmp(rows[0]!.mape!, "0.21") < 0);
    assert.ok(rows[0]!.bias !== null && cmp(rows[0]!.bias!, "0.19") > 0 && cmp(rows[0]!.bias!, "0.21") < 0);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { toUnits } from "./money.ts";
import {
  consumeFifo,
  extendCost,
  issueMovingAverage,
  issueStandard,
  receiveMovingAverage,
  receiveStandard,
  toBaseQuantity,
  type CostLayer,
} from "./inventory-costing.ts";
import {
  buildAssembly,
  getOnHand,
  issueInventory,
  postLandedCostVoucher,
  receiveInventory,
  revalueOpenLayersToStandardCost,
  unitCostPerQuantity,
} from "./inventory.ts";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";

// ---------------------------------------------------------------------------
// extendCost / unit conversion
// ---------------------------------------------------------------------------

test("extendCost multiplies quantity by unit cost, rounded to 4dp", () => {
  assert.equal(extendCost("3", "2.50"), "7.5000");
  assert.equal(extendCost("1.5", "3.3333"), "5.0000"); // 4.99995 → 5.0000
});

test("toBaseQuantity applies the item's unit conversion, else 1:1", () => {
  const conv = { box: 12, pallet: 720 };
  assert.equal(toBaseQuantity("2", "box", conv, "ea"), "24.0000");
  assert.equal(toBaseQuantity("5", "ea", conv, "ea"), "5.0000");
  assert.equal(toBaseQuantity("5", "unknown", conv, "ea"), "5.0000");
});

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

const layers = (): CostLayer[] => [
  { id: "a", remaining: "10", unitCost: "2.00" },
  { id: "b", remaining: "10", unitCost: "3.00" },
];

test("FIFO consumes the oldest layer first at its cost", () => {
  const r = consumeFifo(layers(), "6", "0");
  assert.equal(r.consumptions.length, 1);
  assert.equal(r.consumptions[0]!.layerId, "a");
  assert.equal(r.totalCost, "12.0000"); // 6 × 2.00
  assert.equal(r.shortfallQuantity, "0");
});

test("FIFO spans layers and costs each at its own rate", () => {
  const r = consumeFifo(layers(), "15", "0");
  assert.equal(r.consumptions.length, 2);
  assert.equal(r.consumptions[0]!.cost, "20.0000"); // 10 × 2.00
  assert.equal(r.consumptions[1]!.cost, "15.0000"); // 5 × 3.00
  assert.equal(r.totalCost, "35.0000");
  assert.equal(r.shortfallQuantity, "0");
});

test("FIFO reports a shortfall costed at the fallback when stock runs out", () => {
  const r = consumeFifo(layers(), "25", "3.50");
  assert.equal(r.shortfallQuantity, "5.0000");
  assert.equal(r.shortfallCost, "17.5000"); // 5 × 3.50
  // 20 (layer a) + 30 (layer b) + 17.5 (shortfall) = 67.5
  assert.equal(r.totalCost, "67.5000");
});

test("FIFO consumption cost never exceeds available layer value (round-trip is exact)", () => {
  const ls: CostLayer[] = [{ id: "x", remaining: "3", unitCost: "1.3333" }];
  const r = consumeFifo(ls, "3", "0");
  assert.equal(r.totalCost, extendCost("3", "1.3333")); // both rounded the same way
});

// ---------------------------------------------------------------------------
// Moving average
// ---------------------------------------------------------------------------

test("moving average blends receipts by value", () => {
  let s = { quantity: "0", value: "0" };
  s = receiveMovingAverage(s, "10", "2.00"); // value 20
  s = receiveMovingAverage(s, "10", "4.00"); // value 60, qty 20 → avg 3.00
  assert.equal(s.quantity, "20.0000");
  assert.equal(s.value, "60.0000");
  const iss = issueMovingAverage(s, "5");
  assert.equal(iss.unitCost, "3.0000");
  assert.equal(iss.cost, "15.0000");
  assert.equal(iss.state.value, "45.0000");
  assert.equal(iss.state.quantity, "15.0000");
});

test("moving average drains to exactly zero value when the last unit ships", () => {
  let s = { quantity: "3", value: "10" }; // avg 3.3333…
  const iss = issueMovingAverage(s, "3");
  assert.equal(iss.cost, "10.0000"); // takes ALL remaining value, no rounding residue
  assert.equal(iss.state.quantity, "0.0000");
  assert.equal(iss.state.value, "0.0000");
});

test("moving average partial issue leaves value proportional and non-negative", () => {
  const s = { quantity: "3", value: "10" };
  const iss = issueMovingAverage(s, "1");
  // 10 × 1 / 3 = 3.3333
  assert.equal(iss.cost, "3.3333");
  assert.equal(iss.state.value, "6.6667");
  assert.equal(toUnits(iss.state.value) + toUnits(iss.cost), toUnits("10"));
});

// ---------------------------------------------------------------------------
// Standard cost
// ---------------------------------------------------------------------------

test("standard-cost receipt books inventory at standard and PPV for the delta", () => {
  const r = receiveStandard("10", "2.20", "2.00");
  assert.equal(r.inventoryValue, "20.0000"); // 10 × 2.00 standard
  assert.equal(r.variance, "2.0000"); // 10 × (2.20 − 2.00) unfavorable
});

test("standard-cost receipt yields a favorable (negative) variance when actual is below standard", () => {
  const r = receiveStandard("10", "1.90", "2.00");
  assert.equal(r.variance, "-1.0000");
});

test("standard-cost issue is always at standard", () => {
  assert.equal(issueStandard("7", "2.00"), "14.0000");
});

test("unitCostPerQuantity is half-up so 6 @ 10.0000 is 1.6667, not truncated 1.6666", () => {
  assert.equal(unitCostPerQuantity("10.0000", "6"), "1.6667");
  assert.equal(unitCostPerQuantity("10.0000", "-6"), "-1.6667");
  assert.equal(unitCostPerQuantity("10.0000", "0"), null);
});

// ---------------------------------------------------------------------------
// Standard-cost invariant: the inventory GL equals Σ cost layers, to the penny
// ---------------------------------------------------------------------------

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Sum of posted journal_lines on an account (the GL balance). */
async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}`));
  return r.rows[0]!.bal;
}

/** Σ (remaining_quantity × unit_cost) across every cost layer in the org. */
async function totalLayerValue(orgId: string): Promise<string> {
  const r = (await db.execute<{ v: string }>(sql`
    select coalesce((select sum(round(remaining_quantity * unit_cost, 4))
                       from cost_layers where org_id = ${orgId}), 0)::text as v`));
  return r.rows[0]!.v;
}

/**
 * THE standard-cost invariant, asserted as an exact equality: the inventory
 * asset GL balance must equal the sum of the inventory layers to the penny,
 * and every posted journal entry must balance.
 */
async function assertGlEqualsLayers(org: ScratchOrg): Promise<void> {
  const gl = await glBalance(org.orgId, org.accounts.invAsset);
  const layers = await totalLayerValue(org.orgId);
  assert.equal(toUnits(gl), toUnits(layers), `inventory GL ${gl} != Σ layer value ${layers}`);
  const unbalanced = (await db.execute<{ entry_id: string; bal: string }>(sql`
    select entry_id, sum(amount) as bal from journal_lines
     where org_id = ${orgId} group by entry_id having sum(amount) <> 0`));
  assert.equal(unbalanced.rows.length, 0, `unbalanced entries: ${JSON.stringify(unbalanced.rows)}`);
}

test("standard costing keeps GL = Σ layers through a build, landed cost, a standard-cost revision, and a full drain", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const loc = org.stockLocationId;
    const sub = org.subsidiaryId;

    // A standard-cost assembly (std 3.00) built from the fixture's FIFO
    // component, two per assembly.
    const assembly = randomUUID();
    await db.execute(sql`
      insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
      values (${assembly}, ${org.orgId}, 'inventory', 'Std Assembly', false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`);
    await db.execute(sql`
      insert into item_inventory_profiles
        (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
         variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
      values (${randomUUID()}, ${org.orgId}, ${assembly}, 'standard', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
              ${org.accounts.adjustment}, ${org.accounts.adjustment}, ${org.accounts.clearing}, '3.00', 'ea', '{}'::jsonb)`);
    await db.execute(sql`
      insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
      values (${randomUUID()}, ${org.orgId}, ${assembly}, ${org.items.component}, '2', 0)`);

    // Receipt at 1.10 actual, then build 5 assemblies: components leave at
    // their carried cost (2×5×1.10), the finished good enters at ITS standard
    // (5×3.00), and the 4.00 favorable difference is a build variance — never
    // a mis-valued finished layer.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.component, stockLocationId: loc, quantity: "20", unitCost: "1.10",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.component, loc)).value), toUnits("22"));
    await assertGlEqualsLayers(org);

    const build = await buildAssembly(org.orgId, null, {
      assemblyItemId: assembly, quantity: "5", stockLocationId: loc, subsidiaryId: sub, date: org.date,
    });
    assert.equal(build.value, "15.0000");
    assert.equal(toUnits((await getOnHand(org.orgId, assembly, loc)).value), toUnits("15"));
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.component, loc)).value), toUnits("11"));
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.adjustment)),
      toUnits("-4"),
    ); // favorable build variance credited
    await assertGlEqualsLayers(org);

    // Landed cost on the standard assembly goes to variance; its standard
    // layer must not move by a single penny.
    const invBeforeLanded = await glBalance(org.orgId, org.accounts.invAsset);
    await postLandedCostVoucher(org.orgId, null, {
      amount: "7", basis: "value", freightAccountId: org.accounts.freight,
      subsidiaryId: sub, voucherDate: org.date,
      targets: [{ itemId: assembly, stockLocationId: loc }],
    });
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)) - toUnits(invBeforeLanded), 0n);
    assert.equal(toUnits((await getOnHand(org.orgId, assembly, loc)).value), toUnits("15"));
    await assertGlEqualsLayers(org);

    // Revising the standard cost (3.00 → 3.50) revalues open layers onto the
    // new standard and books the delta atomically — what the costing-profile
    // PUT drives for an item already costing standard.
    const calendar = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} limit 1`));
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId},
             extract(year from current_date)::int,
             extract(month from current_date)::int,
             to_char(current_date, 'YYYY-MM'),
             date_trunc('month', current_date)::date,
             (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
             false, ${calendar.rows[0]!.id}`);
    const invBeforeRevision = await glBalance(org.orgId, org.accounts.invAsset);
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update item_inventory_profiles set standard_cost = '3.50'
         where org_id = ${org.orgId} and item_id = ${assembly}`);
      const entries = await revalueOpenLayersToStandardCost(tx, org.orgId, null, assembly, {
        standardCost: "3.50",
        assetAccountId: org.accounts.invAsset,
        varianceAccountId: org.accounts.adjustment,
        memo: "Standard cost revision revaluation",
      });
      assert.ok(entries);
    });
    assert.equal(toUnits((await getOnHand(org.orgId, assembly, loc)).value), toUnits("17.5"));
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.invAsset)) - toUnits(invBeforeRevision),
      toUnits("2.5"),
    );
    await assertGlEqualsLayers(org);

    // Full drain: issues relieve exactly at standard, so stock zero means the
    // inventory GL is zero — no residual value stranded on the balance sheet.
    await issueInventory(org.orgId, null, {
      itemId: assembly, stockLocationId: loc, quantity: "5", subsidiaryId: sub, date: org.date,
    });
    await issueInventory(org.orgId, null, {
      itemId: org.items.component, stockLocationId: loc, quantity: "10", subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits((await getOnHand(org.orgId, assembly, loc)).quantity), 0n);
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.component, loc)).quantity), 0n);
    const finalGl = await glBalance(org.orgId, org.accounts.invAsset);
    const finalLayers = await totalLayerValue(org.orgId);
    assert.equal(toUnits(finalGl), 0n);
    assert.equal(toUnits(finalLayers), 0n);
    await assertGlEqualsLayers(org);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("control: FIFO receipts and issues keep the same GL-to-layer equality", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const loc = org.stockLocationId;
    const sub = org.subsidiaryId;
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "10", unitCost: "2.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "10", unitCost: "3.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const issue = await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "15", subsidiaryId: sub, date: org.date,
    });
    assert.equal(issue.value, "-35.0000");
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.cogs)), toUnits("35"));
    await assertGlEqualsLayers(org); // 50 − 35 = 15 GL == remaining layer value
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("the costing profile PUT revalues open layers when a standard cost is revised", () => {
  const route = readFileSync(
    new URL("../../web/app/api/items/[id]/costing/route.ts", import.meta.url),
    "utf8",
  );
  // The PUT must treat a standard-cost change on an already-standard item as
  // the same versioned policy event as a switch onto standard: atomic layer
  // revaluation plus variance posting, with the revision in the audit evidence.
  assert.match(route, /revisingStandardCost/);
  assert.match(route, /before\?\.costing_method === 'standard'/);
  assert.match(route, /standardCostRevision/);
  assert.match(route, /revalueOpenLayersToStandardCost/);
});

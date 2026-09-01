import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { toUnits } from "../money.ts";
import {
  getOnHand,
  revalueOpenLayersToStandardCost,
  receiveInventory,
  issueInventory,
} from "../inventory.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { runScenario, type Checkpoint } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The golden harness's inventory gate. AR/AP control accounts have long had a
 * subledger↔GL tie-out; inventory never did, so five variance-routing sites
 * (revaluation with no variance account configured, receipt PPV, assembly
 * build variance, landed cost under standard) could rewrite cost layers while
 * the asset account netted the movement away — GL silently diverging from the
 * stock ledger with no gate noticing. These tests pin the new
 * `inventory-subledger-gl-tieout` check end to end through the real engine:
 * one committed case proving the tie-out HOLDS across receipts, issues, PPV
 * and a standard-cost revision (where variance is routed off the control
 * account), and one committed case proving it FAILS with the exact drift when
 * layers are rewritten while the control account nets to zero — the precise
 * ledger geometry a standard-cost revision with `varianceAccountId = null`
 * produces.
 */

function invCheck(cp: Checkpoint): Checkpoint["checks"][number] {
  const c = cp.checks.find((c) => c.name === "inventory-subledger-gl-tieout");
  assert.ok(c, "checkpoint must carry the inventory tie-out check");
  return c;
}

/** Create an item whose costing profile routes variance nowhere (null). */
async function addStandardItemWithoutVarianceAccount(org: ScratchOrg, name: string, standardCost: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
    values (${id}, ${org.orgId}, 'inventory', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`);
  await db.execute(sql`
    insert into item_inventory_profiles
      (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
       variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
    values (${randomUUID()}, ${org.orgId}, ${id}, 'standard', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
            ${org.accounts.adjustment}, null, ${org.accounts.clearing}, ${standardCost}, 'ea', '{}'::jsonb)`);
  return id;
}

test("inventory-subledger-gl-tieout holds across receipt, issue, PPV and standard-cost revision", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sub = org.subsidiaryId;
    const loc = org.stockLocationId;

    // FIFO: two receipts then an issue spanning layers.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "100", unitCost: "2.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "100", unitCost: "3.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "150", subsidiaryId: sub, date: org.date,
    });
    // Moving average.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.movingAvg, stockLocationId: loc, quantity: "10", unitCost: "4.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    // Standard costing: actual 2.20 vs standard 2.00 → PPV routes to the
    // adjustment account (a variance ACCOUNT, not the control account).
    await receiveInventory(org.orgId, null, {
      itemId: org.items.standard, stockLocationId: loc, quantity: "10", unitCost: "2.20",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    // Revise the standard cost while a variance account IS configured: layers
    // and GL must move together (Δ = 10 × (3.00 − 2.00) = 10 onto both).
    // The revision dates itself at businessToday, so give the scratch org an
    // open period covering the real current month.
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId},
             extract(year from current_date)::int,
             extract(month from current_date)::int,
             to_char(current_date, 'YYYY-MM'),
             date_trunc('month', current_date)::date,
             (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
             false, fiscal_calendar_id
        from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`);
    const entries = await db.transaction((tx) =>
      revalueOpenLayersToStandardCost(
        tx, org.orgId, null, org.items.standard,
        { standardCost: "3.00", assetAccountId: org.accounts.invAsset, varianceAccountId: org.accounts.adjustment },
      ),
    );
    assert.ok(entries && entries.length === 1, "revision must post exactly one entry");
    const stdValue = await getOnHand(org.orgId, org.items.standard, loc);
    assert.equal(toUnits(stdValue.value), toUnits("30"), "layers must carry 10 × 3.00 after revision");

    const cp = await runScenario(org.orgId, { at: org.date });
    const check = invCheck(cp);
    assert.equal(check.ok, true, `tie-out must hold: ${check.detail}`);
    assert.equal(cp.pass, true, "the whole fixture must pass on a tied ledger");
    assert.equal(cp.inventoryTieOut.length, 1, "one entity/control-account row (fixture shares one asset account)");
    const row = cp.inventoryTieOut[0]!;
    assert.equal(row.subsidiary, "Main Co");
    assert.equal(row.number, "1300");
    assert.equal(row.methods.split(",").sort().join(","), "fifo,moving_average,standard");
    // FIFO remainder 50×3 + average 10×4 + standard 10×3 = 220 on BOTH sides.
    assert.equal(toUnits(row.subledger), toUnits("220"));
    assert.equal(toUnits(row.gl), toUnits(row.subledger));
    assert.equal(toUnits(row.diff), 0n);
    assert.match(check.detail, /worst \|GL − Σ open layers\| = 0\.0000/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory-subledger-gl-tieout fails when layers are rewritten while the control account nets to zero", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sub = org.subsidiaryId;
    const loc = org.stockLocationId;
    const item = await addStandardItemWithoutVarianceAccount(org, "Unrouted Std Widget", "2.00");

    // Receive at actual == standard so no PPV arises: DR asset 10.00 / CR clearing.
    await receiveInventory(org.orgId, null, {
      itemId: item, stockLocationId: loc, quantity: "5", unitCost: "2.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    // The exact ledger geometry of revising standard cost with NO variance
    // account: every open layer is rewritten onto the new standard while the
    // balancing leg posts back into the SAME control account, netting zero —
    // layers jump +5.00, the asset balance does not move at all.
    await db.execute(sql`
      update cost_layers set unit_cost = '3.00' where org_id = ${org.orgId} and item_id = ${item}`);
    const probeEntryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${probeEntryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${"INV-TIEOUT-PROBE-" + probeEntryId.slice(0, 8)},
              ${org.date}, ${org.periodId}, 'probe', 'draft', 'inventory', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${probeEntryId}, 1, ${org.accounts.invAsset}, ${sub}, '5.0000', 'CAD', '5.0000', 1, 'net-zero pair'),
             (${org.orgId}, ${probeEntryId}, 2, ${org.accounts.invAsset}, ${sub}, '-5.0000', 'CAD', '-5.0000', 1, 'net-zero pair')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${probeEntryId}`);
    const dr = await db.execute<{ n: string }>(sql`
      select count(*) n from journal_lines where entry_id = ${probeEntryId}`);
    assert.equal(Number(dr.rows[0]!.n), 2);

    const cp = await runScenario(org.orgId, { at: org.date });
    const check = invCheck(cp);
    assert.equal(check.ok, false, "the tie-out MUST fail on the diverged ledger");
    assert.equal(cp.pass, false, "a diverged fixture cannot be golden");
    // Whole checkpoint still balanced elsewhere: only the tie-out caught it.
    for (const other of cp.checks.filter((c) => c.name !== "inventory-subledger-gl-tieout")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — the tie-out is the gate that fires`);
    }
    assert.equal(cp.inventoryTieOut.length, 1);
    const row = cp.inventoryTieOut[0]!;
    assert.equal(row.subsidiary, "Main Co");
    assert.equal(toUnits(row.gl), toUnits("10"), "control account unchanged by the net-zero pair");
    assert.equal(toUnits(row.subledger), toUnits("15"), "layers carry the rewritten value");
    assert.equal(toUnits(row.diff), toUnits("-5"));
    assert.match(check.detail, /worst \|GL − Σ open layers\| = 5\.0000/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

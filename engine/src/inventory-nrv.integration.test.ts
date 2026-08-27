import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  getOnHand,
  issueInventory,
  receiveInventory,
  revalueOpenLayersToStandardCost,
} from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import { orgReportingFramework } from "./reporting-framework.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`));
  return toUnits(r.rows[0]!.bal);
}

async function setFramework(orgId: string, framework: "us_gaap" | "ifrs"): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({ reportingFramework: framework })}::jsonb
     where id = ${orgId}`);
}

async function setTaxFramework(orgId: string, framework: "asc740" | "ias12"): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({ taxFramework: framework })}::jsonb
     where id = ${orgId}`);
}

test("NRV write-down remeasures value only, keeps subledger = GL, and new basis flows to COGS", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setFramework(org.orgId, "us_gaap");
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "100",
      unitCost: "3",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.ap,
      date: org.date,
    });

    const result = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2",
    });
    assert.equal(result.amount, "100.0000");
    assert.equal(result.previousValue, "300.0000");
    assert.equal(result.newValue, "200.0000");

    // Quantity unchanged; value = NRV; subledger agrees with the GL.
    const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.quantity), toUnits("100"));
    assert.equal(toUnits(onHand.value), toUnits("200"));
    assert.equal(await glBalance(org.orgId, org.accounts.invAsset), toUnits("200"));
    assert.equal(await glBalance(org.orgId, org.accounts.adjustment), toUnits("100"));

    // The written-down cost is the basis future issues consume (IAS 2.34).
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.cogs,
      date: org.date,
    });
    const after = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(after.quantity), toUnits("90"));
    assert.equal(toUnits(after.value), toUnits("180")); // 90 × 2.00
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("tax-framework edits do not reinterpret the reporting policy or prior NRV evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setFramework(org.orgId, "us_gaap");
    await setTaxFramework(org.orgId, "asc740");
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "3",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.ap,
      date: org.date,
    });
    const writedown = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2",
    });
    assert.equal(writedown.framework, "us_gaap");

    // Income-tax presentation can change independently. The authoritative
    // reporting policy and the framework snapshot on committed evidence stay
    // US GAAP, so a reversal remains prohibited after the tax edit.
    await setTaxFramework(org.orgId, "ias12");
    assert.equal(await orgReportingFramework(org.orgId), "us_gaap");
    const evidence = await db.execute<{ framework: string }>(sql`
      select framework from inventory_writedowns
       where id = ${writedown.writedownId} and org_id = ${org.orgId}`);
    assert.equal(evidence.rows[0]?.framework, "us_gaap");
    await assert.rejects(
      reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        nrvPerUnit: "3",
      }),
      /prohibited under US GAAP/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("NRV reversal: IFRS capped at the write-down, US GAAP refused, over-reversal impossible", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setFramework(org.orgId, "ifrs");
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "100",
      unitCost: "3",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.ap,
      date: org.date,
    });
    await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2",
    });

    // NRV recovers to 3.50 — ABOVE original cost. The reversal must stop at
    // cost (release only the 100.00 written down), never above it (IAS 2.33).
    const reversal = await reverseInventoryWritedown(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "3.50",
    });
    assert.equal(reversal.amount, "100.0000");
    const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.value), toUnits("300")); // back to cost, not 350

    // Nothing left to reverse.
    await assert.rejects(
      reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        nrvPerUnit: "3.50",
      }),
      /no unreversed write-down/,
    );

    // The same recovery under US GAAP is refused outright.
    await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2.50",
    });
    await setFramework(org.orgId, "us_gaap");
    await assert.rejects(
      reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        nrvPerUnit: "3.00",
      }),
      /prohibited under US GAAP/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("NRV write-down distributes exactly across uneven layers — no lost cent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Three layers whose values do not divide evenly: 7 @ 1.13, 11 @ 2.07, 3 @ 5.55.
    for (const [quantity, unitCost] of [
      ["7", "1.13"],
      ["11", "2.07"],
      ["3", "5.55"],
    ] as const) {
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity,
        unitCost,
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.ap,
        date: org.date,
      });
    }
    const before = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    // 7.91 + 22.77 + 16.65 = 47.33 over 21 units.
    assert.equal(toUnits(before.value), toUnits("47.33"));

    // NRV 1.37/unit → target 21 × 1.37 = 28.77; write-down 18.56.
    const result = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "1.37",
    });
    assert.equal(result.amount, "18.5600");

    const after = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(after.value), toUnits("28.77")); // exact to the hundredth of a cent
    assert.equal(toUnits(after.quantity), toUnits("21"));
    // Subledger and GL agree exactly after the layer arithmetic.
    assert.equal(await glBalance(org.orgId, org.accounts.invAsset), toUnits("28.77"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Mixed-owner revaluation: legal-entity scoping
//
// A shared warehouse can hold one item's layers under several legal entities.
// Revaluation must measure, write, and post PER OWNER — one set of layer
// writes and one journal per entity — so each entity's GL keeps equalling its
// own layers. Booking the whole position's adjustment to the caller's entity
// moved every subsidiary's inventory value into one set of books.
// ---------------------------------------------------------------------------

/** The org root plus one child legal entity beneath it. */
async function createChildSubsidiary(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Reval Sub Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

/** Sum of posted journal lines on an account for ONE legal entity. */
async function entityGlBalance(
  orgId: string,
  accountId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${accountId}
       and e.subsidiary_id = ${subsidiaryId}`));
  return toUnits(r.rows[0]!.bal);
}

/** Σ (remaining × unit_cost) across one entity's layers at a position. */
async function entityLayerValue(
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = (await db.execute<{ v: string }>(sql`
    select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as v
      from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
       and stock_location_id = ${stockLocationId}
       and subsidiary_id = ${subsidiaryId}`));
  return toUnits(r.rows[0]!.v);
}

/** Every posted entry must balance WITHIN each legal entity. */
async function assertEntriesBalancedPerEntity(orgId: string): Promise<void> {
  const r = (await db.execute(sql`
    select e.subsidiary_id, l.entry_id, sum(l.amount) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId}
     group by e.subsidiary_id, l.entry_id
    having sum(l.amount) <> 0`));
  assert.equal(r.rows.length, 0, "an entry is unbalanced inside a subsidiary");
}

test("a mixed-owner NRV write-down revalues each legal entity separately", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setFramework(org.orgId, "ifrs");
    const subA = org.subsidiaryId;
    const subB = await createChildSubsidiary(org);

    // Both entities hold the SAME item in the SAME shared warehouse.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "3",
      subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "20", unitCost: "5",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    // NRV 2.00/unit: A (10 @ 3.00) writes down 10.00; B (20 @ 5.00) writes
    // down 60.00. Each owner gets its own layer writes and its own journal.
    const result = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: subA,
      date: org.date,
      nrvPerUnit: "2",
    });
    assert.equal(result.amount, "70.0000");
    assert.equal(result.previousValue, "130.0000");
    assert.equal(result.newValue, "60.0000");
    assert.equal(toUnits(result.quantity), toUnits("30"));
    assert.ok(Array.isArray(result.entities), "result must carry per-entity postings");
    assert.equal(result.entities.length, 2);
    const byOwner = new Map(result.entities.map((e) => [e.subsidiaryId, e]));
    const postingOf = (subsidiaryId: string) => {
      const p = byOwner.get(subsidiaryId)!;
      return { previousValue: p.previousValue, newValue: p.newValue, amount: p.amount };
    };
    assert.deepEqual(postingOf(subA), {
      previousValue: "30.0000",
      newValue: "20.0000",
      amount: "10.0000",
    });
    assert.deepEqual(postingOf(subB), {
      previousValue: "100.0000",
      newValue: "40.0000",
      amount: "60.0000",
    });

    // Each posting journalized under ITS owner, never the caller's entity.
    for (const e of result.entities) {
      const je = (await db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id::text as "subsidiary_id"
          from journal_entries where id = ${e.entryId} and org_id = ${org.orgId}`));
      assert.equal(je.rows[0]!.subsidiary_id, e.subsidiaryId);
    }

    // Write-down evidence rows are per owner too.
    const evidence = (await db.execute<{ subsidiary_id: string; amount: string; reversed_amount: string }>(sql`
      select subsidiary_id::text as "subsidiary_id", amount::text as amount, reversed_amount::text as "reversed_amount"
        from inventory_writedowns
       where org_id = ${org.orgId} and kind = 'writedown'`));
    assert.deepEqual(
      new Map(evidence.rows.map((r) => [r.subsidiary_id, { amount: r.amount, reversed_amount: r.reversed_amount }])),
      new Map([
        [subA, { amount: "10.0000", reversed_amount: "0.0000" }],
        [subB, { amount: "60.0000", reversed_amount: "0.0000" }],
      ]),
    );

    // Per-entity GL exactly equals per-entity layers after the revaluation.
    assert.equal(await entityGlBalance(org.orgId, org.accounts.invAsset, subA), toUnits("20"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.invAsset, subB), toUnits("40"));
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subA), toUnits("20"));
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subB), toUnits("40"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.adjustment, subA), toUnits("10"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.adjustment, subB), toUnits("60"));

    // An IFRS recovery reverses ONLY the requesting entity's write-down:
    // B recovers toward 3.00 while A stays written down.
    const reversalB = await reverseInventoryWritedown(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: subB,
      date: org.date,
      nrvPerUnit: "3",
    });
    assert.equal(reversalB.amount, "20.0000");
    const reversalEntry = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text as "subsidiary_id"
        from journal_entries where id = ${reversalB.entryId} and org_id = ${org.orgId}`));
    assert.equal(reversalEntry.rows[0]!.subsidiary_id, subB);
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subA), toUnits("20"));
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subB), toUnits("60"));
    const aStillOpen = (await db.execute<{ reversed_amount: string }>(sql`
      select reversed_amount::text as "reversed_amount"
        from inventory_writedowns
       where org_id = ${org.orgId} and subsidiary_id = ${subA} and kind = 'writedown'`));
    assert.equal(aStillOpen.rows[0]!.reversed_amount, "0.0000");

    // Then A recovers — capped at its own write-down, back to cost exactly.
    const reversalA = await reverseInventoryWritedown(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: subA,
      date: org.date,
      nrvPerUnit: "3",
    });
    assert.equal(reversalA.amount, "10.0000");
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subA), toUnits("30"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.invAsset, subA), toUnits("30"));
    await assertEntriesBalancedPerEntity(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("standard-cost revaluation posts one balanced entry per owning legal entity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    const subB = await createChildSubsidiary(org);

    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "4", unitCost: "1",
      subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await db.execute(sql`
      update item_inventory_profiles set standard_cost = '3'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);

    // The engine dates the revaluation itself; open a period covering today.
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
             false, ${calendar.rows[0]!.id}
      on conflict do nothing`);

    // Standard cost 3.00: A revalues +8.00 (4 units), B +10.00 (10 units).
    const entryIds = await db.transaction((tx) =>
      revalueOpenLayersToStandardCost(tx, org.orgId, null, org.items.fifo, {
        standardCost: "3",
        assetAccountId: org.accounts.invAsset,
        varianceAccountId: org.accounts.adjustment,
      }));
    assert.ok(Array.isArray(entryIds), "revaluation must report one entry per owning entity");
    assert.equal(entryIds.length, 2);
    assert.notEqual(entryIds[0], entryIds[1]);

    const posted = (await db.execute<{ subsidiary_id: string; delta: string }>(sql`
      select e.subsidiary_id::text as "subsidiary_id",
             sum(case when l.account_id = ${org.accounts.invAsset} then l.amount else 0 end)::text as delta
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.id in (${entryIds[0]}, ${entryIds[1]}) and e.org_id = ${org.orgId}
       group by e.subsidiary_id`));
    assert.deepEqual(
      new Map(posted.rows.map((r) => [r.subsidiary_id, r.delta])),
      new Map([
        [subA, "8.0000"],
        [subB, "10.0000"],
      ]),
    );

    // Per-entity GL exactly equals per-entity layers after the revaluation.
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subA), toUnits("12"));
    assert.equal(await entityLayerValue(org.orgId, org.items.fifo, org.stockLocationId, subB), toUnits("30"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.invAsset, subA), toUnits("12"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.invAsset, subB), toUnits("30"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.adjustment, subA), toUnits("-8"));
    assert.equal(await entityGlBalance(org.orgId, org.accounts.adjustment, subB), toUnits("-10"));
    await assertEntriesBalancedPerEntity(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { approveFixtureRouting, createManufacturingOperator } from "../testing/manufacturing.ts";
import { ManufacturingError } from "./errors.ts";
import { createWorkCenter } from "./work-centers.ts";
import { createRouting, createRoutingOperation } from "./routings.ts";
import { createWorkOrder, releaseWorkOrder } from "./work-orders.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function run<T>(orgId: string, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, () => work(db));
}

async function setupOrg(): Promise<{ org: ScratchOrg; actorId: string; departmentId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() =>
      createManufacturingOperator(org.orgId, "Shop lead"),
    );
    const wipId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${wipId}, ${org.orgId}, '1210', 'Manufacturing WIP', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(sql`update orgs set settings = jsonb_set(jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"manufacturing": true, "inventory": true, "warehousing": true}'::jsonb), '{controlAccounts}',
        coalesce(settings->'controlAccounts', '{}'::jsonb) || jsonb_build_object('mfgWip', ${wipId}::text), true)
        where id = ${org.orgId}`);
      await db.execute(sql`update bom_components set quantity_per = '2', operation_seq = null, is_byproduct = false
        where org_id = ${org.orgId} and assembly_item_id = ${org.items.assembly} and component_item_id = ${org.items.component}`);
    });
    const departmentId = String(
      (
        await withBypassContext(() =>
          db.execute(
            sql`insert into departments (org_id, name) values (${org.orgId}, 'Assembly') returning id`,
            "objects",
          ),
        )
      )[0]!.id,
    );
    return { org, actorId, departmentId };
  } catch (error) {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

async function rate(
  f: { org: ScratchOrg; actorId: string; departmentId: string },
  from: string,
  to: string | null,
  value: string,
): Promise<string> {
  return String(
    (
      await withBypassContext(() =>
        db.execute(
          sql`insert into labor_cost_rates
    (org_id, department_id, currency, rate, basis, annual_hours, effective_from, effective_to, is_active, created_by, updated_by)
    values (${f.org.orgId}, ${f.departmentId}, 'CAD', ${value}, 'hour', '2080', ${from}, ${to}, true, ${f.actorId}, ${f.actorId}) returning id`,
          "objects",
        ),
      )
    )[0]!.id,
  );
}

async function routeWithBareCenter(
  f: { org: ScratchOrg; actorId: string },
  effectiveFrom: string,
  effectiveTo: string | null,
): Promise<void> {
  const center = await run(f.org.orgId, (tx) =>
    createWorkCenter(tx, f.org.orgId, f.actorId, {
      code: `WC-${randomUUID()}`,
      name: "Backdated center",
      kind: "machine",
      capacityHoursPerDay: "8",
      efficiencyPct: "100",
      absorbsOverhead: false,
    }),
  );
  const routing = await run(f.org.orgId, (tx) =>
    createRouting(tx, f.org.orgId, f.actorId, {
      producedItemId: f.org.items.assembly,
      code: `RT-${randomUUID()}`,
      name: "Backdated route",
      effectiveFrom,
      effectiveTo,
      defaultIssueLocationId: f.org.stockLocationId,
      defaultReceiptLocationId: f.org.stockLocationId2,
      overheadBasis: "units",
    }),
  );
  await run(f.org.orgId, (tx) =>
    createRoutingOperation(
      tx,
      f.org.orgId,
      f.actorId,
      String((routing as Record<string, unknown>).id),
      {
        sequence: 10,
        name: "Assemble",
        workCenterId: String((center as Record<string, unknown>).id),
        setupMinutes: "0",
        runMinutesPerUnit: "1",
      },
    ),
  );
  await approveFixtureRouting(
    f.org.orgId,
    f.actorId,
    String((routing as Record<string, unknown>).id),
  );
}

test(
  "back-dated release resolves the rates and routing effective on the order date",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      const oldRateId = await rate(f, "2025-01-01", "2025-12-31", "25");
      await routeWithBareCenter(f, "2025-01-01", "2025-12-31");
      const draft = await run(f.org.orgId, (tx) =>
        createWorkOrder(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          quantityOrdered: "1",
          subsidiaryId: f.org.subsidiaryId,
          issueLocationId: f.org.stockLocationId,
          receiptLocationId: f.org.stockLocationId2,
          plannedStart: "2025-10-27",
        }),
      );
      const released = await run(f.org.orgId, (tx) =>
        releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id),
      );
      assert.equal(released.status, "released");
      const operation = (
        await withBypassContext(
          async () =>
            await db.execute<{ wageId: string; wageFrom: string }>(
              sql`
      select standard_labor_wage_id as "wageId", standard_labor_effective_from::text as "wageFrom"
        from mfg_wo_operations where org_id = ${f.org.orgId} and work_order_id = ${draft.id}`,
              "objects",
            ),
        )
      )[0]!;
      assert.equal(
        operation.wageId,
        oldRateId,
        "the frozen snapshot must carry the then-effective rate",
      );
      assert.equal(operation.wageFrom, "2025-01-01");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test("back-dated release names the order date when no rate covers it", { skip: !DB }, async () => {
  const f = await setupOrg();
  try {
    await rate(f, "2026-01-01", null, "30");
    await routeWithBareCenter(f, "2025-01-01", null);
    const draft = await run(f.org.orgId, (tx) =>
      createWorkOrder(tx, f.org.orgId, f.actorId, {
        producedItemId: f.org.items.assembly,
        quantityOrdered: "1",
        subsidiaryId: f.org.subsidiaryId,
        issueLocationId: f.org.stockLocationId,
        receiptLocationId: f.org.stockLocationId2,
        plannedStart: "2025-10-27",
      }),
    );
    await assert.rejects(
      run(f.org.orgId, (tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)),
      (error: unknown) => {
        assert.ok(
          error instanceof ManufacturingError && error.code === "standard_labor_rate_missing",
        );
        assert.match(
          error.message,
          /2025-10-27/,
          "the refusal must name the order date, never today",
        );
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

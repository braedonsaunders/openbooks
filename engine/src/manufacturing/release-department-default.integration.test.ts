import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withBypassContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { approveFixtureRouting, createManufacturingOperator } from "../testing/manufacturing.ts";
import { ManufacturingError } from "./errors.ts";
import { createWorkCenter, updateWorkCenter } from "./work-centers.ts";
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
    await withBypassContext(() =>
      db.execute(sql`insert into labor_cost_rates
      (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId})`),
    );
    return { org, actorId, departmentId };
  } catch (error) {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

async function routeWithBareCenter(f: {
  org: ScratchOrg;
  actorId: string;
}): Promise<{ routingId: string; centerId: string }> {
  const center = await run(f.org.orgId, (tx) =>
    createWorkCenter(tx, f.org.orgId, f.actorId, {
      code: `WC-${randomUUID()}`,
      name: "Roast center",
      kind: "machine",
      capacityHoursPerDay: "8",
      efficiencyPct: "100",
      absorbsOverhead: false,
    }),
  );
  assert.equal(String((center as Record<string, unknown>).departmentId ?? ""), "");
  const routing = await run(f.org.orgId, (tx) =>
    createRouting(tx, f.org.orgId, f.actorId, {
      producedItemId: f.org.items.assembly,
      code: `RT-${randomUUID()}`,
      name: "Assembly route",
      effectiveFrom: "2026-01-01",
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
  return {
    routingId: String((routing as Record<string, unknown>).id),
    centerId: String((center as Record<string, unknown>).id),
  };
}

async function draft(f: { org: ScratchOrg; actorId: string }): Promise<string> {
  const order = await run(f.org.orgId, (tx) =>
    createWorkOrder(tx, f.org.orgId, f.actorId, {
      producedItemId: f.org.items.assembly,
      quantityOrdered: "1",
      subsidiaryId: f.org.subsidiaryId,
      issueLocationId: f.org.stockLocationId,
      receiptLocationId: f.org.stockLocationId2,
      plannedStart: f.org.date,
    }),
  );
  return order.id;
}

test(
  "release defaults an unassigned work center to the org's single active department",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      await routeWithBareCenter(f);
      const first = await draft(f);
      const released = await run(f.org.orgId, (tx) =>
        releaseWorkOrder(tx, f.org.orgId, f.actorId, first),
      );
      assert.equal(released.status, "released");

      await withBypassContext(() =>
        db.execute(sql`insert into departments (org_id, name) values (${f.org.orgId}, 'Packing')`),
      );
      const second = await draft(f);
      await assert.rejects(
        run(f.org.orgId, (tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, second)),
        (error: unknown) => {
          assert.ok(
            error instanceof ManufacturingError && error.code === "work_center_department_required",
          );
          assert.match(error.remedy ?? "", /Manufacturing → Work centers/);
          assert.ok(
            !(error.remedy ?? "").includes("Company Settings"),
            "an ambiguous default points at the drawer, not setup",
          );
          return true;
        },
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "release without any department names department setup and the drawer",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      await routeWithBareCenter(f);
      await withBypassContext(async () => {
        await db.execute(sql`delete from labor_cost_rates where org_id = ${f.org.orgId}`);
        await db.execute(sql`delete from departments where org_id = ${f.org.orgId}`);
      });
      const third = await draft(f);
      await assert.rejects(
        run(f.org.orgId, (tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, third)),
        (error: unknown) => {
          assert.ok(
            error instanceof ManufacturingError && error.code === "work_center_department_required",
          );
          assert.match(error.remedy ?? "", /Company Settings → Departments/);
          assert.match(error.remedy ?? "", /Manufacturing → Work centers/);
          return true;
        },
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "department assignment on a work center saves with an audit trail",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      const center = await run(f.org.orgId, (tx) =>
        createWorkCenter(tx, f.org.orgId, f.actorId, {
          code: `WC-${randomUUID()}`,
          name: "Roast center",
          kind: "machine",
          capacityHoursPerDay: "8",
          efficiencyPct: "100",
          absorbsOverhead: false,
        }),
      );
      const id = String((center as Record<string, unknown>).id);
      const updated = await run(f.org.orgId, (tx) =>
        updateWorkCenter(tx, f.org.orgId, f.actorId, id, { departmentId: f.departmentId }),
      );
      assert.equal(String((updated as Record<string, unknown>).departmentId), f.departmentId);
      const audit = (
        await withBypassContext(
          async () =>
            await db.execute<{ n: number }>(
              sql`
      select count(*)::int as n from audit_log
       where org_id = ${f.org.orgId} and table_name = 'mfg_work_centers' and row_id = ${id} and action = 'update'`,
              "objects",
            ),
        )
      )[0]!.n;
      assert.equal(audit, 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

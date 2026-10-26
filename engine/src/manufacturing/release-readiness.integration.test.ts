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
import { createWorkOrder, readWorkOrderReleaseReadiness, releaseWorkOrder } from "./work-orders.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function run<T>(orgId: string, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, () => work(db));
}

/** Two departments and no labor rates: nothing can default, so every gap shows. */
async function setupOrg(): Promise<{ org: ScratchOrg; actorId: string; departments: string[] }> {
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
    const departments: string[] = [];
    for (const name of ["Roasting", "Packing"]) {
      departments.push(
        String(
          (
            await withBypassContext(() =>
              db.execute(
                sql`
        insert into departments (org_id, name) values (${org.orgId}, ${name}) returning id`,
                "objects",
              ),
            )
          )[0]!.id,
        ),
      );
    }
    return { org, actorId, departments };
  } catch (error) {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

test(
  "a draft work order lists every unmet release prerequisite at once, and release agrees",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      const centers: string[] = [];
      for (const name of ["Roast", "Pack"]) {
        const center = await run(f.org.orgId, (tx) =>
          createWorkCenter(tx, f.org.orgId, f.actorId, {
            code: `WC-${randomUUID()}`,
            name,
            kind: "machine",
            capacityHoursPerDay: "8",
            efficiencyPct: "100",
            absorbsOverhead: false,
          }),
        );
        centers.push(String((center as Record<string, unknown>).id));
      }
      const routing = await run(f.org.orgId, (tx) =>
        createRouting(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          code: `RT-${randomUUID()}`,
          name: "Roast and pack",
          effectiveFrom: "2026-01-01",
          defaultIssueLocationId: f.org.stockLocationId,
          defaultReceiptLocationId: f.org.stockLocationId2,
          overheadBasis: "units",
        }),
      );
      const routingId = String((routing as Record<string, unknown>).id);
      for (const [index, centerId] of centers.entries()) {
        await run(f.org.orgId, (tx) =>
          createRoutingOperation(tx, f.org.orgId, f.actorId, routingId, {
            sequence: (index + 1) * 10,
            name: `Step ${index + 1}`,
            workCenterId: centerId,
            setupMinutes: "0",
            runMinutesPerUnit: "1",
          }),
        );
      }
      await approveFixtureRouting(f.org.orgId, f.actorId, routingId);
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

      const blocked = await run(f.org.orgId, (tx) =>
        readWorkOrderReleaseReadiness(tx, f.org.orgId, f.actorId, order.id),
      );
      assert.equal(blocked.status, "blocked");
      const departmentGaps = blocked.findings.filter(
        (finding) => finding.code === "work_center_department_required",
      );
      assert.equal(
        departmentGaps.length,
        2,
        "both operations' missing departments are listed together, not one per attempt",
      );
      assert.ok(
        departmentGaps.every((finding) => finding.href === "/manufacturing/work-centers"),
        "each gap links to where it is resolved",
      );
      const unchanged = (
        await withBypassContext(() =>
          db.execute<{ status: string; n: number }>(
            sql`
      select w.status, (select count(*)::int from mfg_wo_operations o where o.org_id = w.org_id and o.work_order_id = w.id) as n
        from mfg_work_orders w where w.org_id = ${f.org.orgId} and w.id = ${order.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(
        unchanged,
        { status: "draft", n: 0 },
        "reading readiness never releases or snapshots the order",
      );

      await assert.rejects(
        run(f.org.orgId, (tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, order.id)),
        (error: unknown) => {
          assert.ok(error instanceof ManufacturingError);
          assert.ok(
            blocked.findings.some((finding) => finding.code === error.code),
            "release refuses with a prerequisite readiness listed",
          );
          return true;
        },
      );

      for (const [index, centerId] of centers.entries()) {
        await run(f.org.orgId, (tx) =>
          updateWorkCenter(tx, f.org.orgId, f.actorId, centerId, {
            departmentId: f.departments[index]!,
          }),
        );
      }
      for (const departmentId of f.departments) {
        await withBypassContext(() =>
          db.execute(sql`insert into labor_cost_rates
        (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
        values (${f.org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${f.actorId}, ${f.actorId})`),
        );
      }
      const ready = await run(f.org.orgId, (tx) =>
        readWorkOrderReleaseReadiness(tx, f.org.orgId, f.actorId, order.id),
      );
      assert.deepEqual(ready, { status: "ready", findings: [] });
      const released = await run(f.org.orgId, (tx) =>
        releaseWorkOrder(tx, f.org.orgId, f.actorId, order.id),
      );
      assert.equal(released.status, "released", "a ready order releases");
      const after = await run(f.org.orgId, (tx) =>
        readWorkOrderReleaseReadiness(tx, f.org.orgId, f.actorId, order.id),
      );
      assert.equal(after.status, "not_draft");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

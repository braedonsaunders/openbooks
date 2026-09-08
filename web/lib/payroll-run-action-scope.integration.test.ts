import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-action-scope")] = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-action-scope')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { mutatePayRunAdjustment } = await import("@openbooks/engine/src/payroll-run-adjustments.ts");
const { POST } = await import("../app/api/payroll/runs/[id]/route");

for (const action of ["add-adjustment", "delete-adjustment", "exclude-employee", "include-employee", "bulk-adjustment", "set-scope", "preview-gl"] as const) {
  test(`payroll ${action} refuses an inaccessible employee in a visible run`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Hidden payroll employer','CAD','CA')`);
      await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      const { input } = await calculatedRun(fx);
      const componentId = (await db.execute<{ id: string }>(sql`select id from pay_components where org_id=${fx.orgId} and system_key='base_pay' and kind='earning'`)).rows[0]!.id;
      let adjustmentId: string | undefined;
      if (action === "delete-adjustment" || action === "include-employee") {
        await mutatePayRunAdjustment({ ...input, mutation: { action: "exclude", employeePartyId: fx.employeeId } });
        adjustmentId = (await db.execute<{ id: string }>(sql`select id from pay_run_adjustments where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`)).rows[0]!.id;
      }
      state.gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.run"]), allowedSubsidiaryIds: new Set([fx.subsidiaryId]) } as Authz;
      const snapshot = async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
        'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${input.documentId}),
        'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${fx.orgId}),
        'adjustments',(select jsonb_agg(to_jsonb(a) order by id) from pay_run_adjustments a where org_id=${fx.orgId})
        ) as state`)).rows[0]!.state;
      const before = await snapshot();
      const body = { action, employeePartyId: fx.employeeId, componentId, amount: "10", adjustmentId,
        employeePartyIds: action === "set-scope" ? [] : [fx.employeeId], rosterPartyIds: [fx.employeeId] };
      const send = () => POST(new Request("https://openbooks.test/api/payroll/runs/fixture", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: input.documentId }) });
      const response = await send();
      assert.equal(response.status, 422, JSON.stringify(await response.json()));
      assert.deepEqual(await snapshot(), before, "refusal must preserve the complete run snapshot and adjustments");
      state.gate = { ...state.gate, allowedSubsidiaryIds: null };
      assert.equal((await send()).status, 200, "unrestricted payroll operations remain available");
    } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
  });
}

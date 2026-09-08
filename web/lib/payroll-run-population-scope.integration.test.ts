import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ListViewConfig } from "@openbooks/customization";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-population-scope")] = state;
registerHooks({ resolve(specifier, context, next) {
  const parent = decodeURIComponent(context.parentURL ?? "");
  const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
  if (specifier === "server-only") return virtual("export {}");
  if (specifier === "next-intl/server") return virtual("export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}");
  if (specifier.endsWith("/lib/feature-gates") && parent.endsWith("/api/payroll/runs/route.ts")) return virtual(
    "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-population-scope')].gate}");
  if (parent.endsWith("/payroll/runs/[id]/page.tsx")) {
    if (specifier.endsWith("/lib/authz")) return virtual(
      "export async function requirePermission(){return globalThis[Symbol.for('openbooks.payroll-run-population-scope')].gate};export function can(){return true}");
    if (specifier.endsWith("/module-home/group-tabs")) return virtual("export async function groupTabs(){return []}");
    if (specifier === "./RunWizard") return virtual("export function RunWizard(){return null}");
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { GET } = await import("../app/api/payroll/runs/route");
const { PAYROLL_TOOLS } = await import("./assistant/tools-payroll");
const { payRunWhere } = await import("./customization/list-query");
const { default: Page } = await import("../app/(app)/payroll/runs/[id]/page");

for (const surface of ["collection", "record list", "assistant list", "assistant detail", "wizard"] as const) {
  test(`payroll population scope: ${surface}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Hidden payroll population','CAD','CA')`);
      await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${fx.orgId}`);
      const { input } = await calculatedRun(fx);
      const gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.read", "payroll.run"]), allowedSubsidiaryIds: new Set([fx.subsidiaryId]) } as Authz;
      state.gate = gate;
      const read = async (visible: boolean) => {
        if (surface === "collection") {
          const response = await GET(); assert.equal(response.status, 200);
          const rows = (await response.json()).runs as { document_id: string }[];
          assert.equal(rows.some((row) => row.document_id === input.documentId), visible);
        } else if (surface === "record list") {
          const where = payRunWhere(["pay_run"], { filters: [] } as unknown as ListViewConfig, {}, fx.orgId, state.gate!.allowedSubsidiaryIds);
          const rows = (await db.execute<{ id: string }>(sql`select d.id from documents d where ${where}`)).rows;
          assert.equal(rows.some((row) => row.id === input.documentId), visible);
        } else if (surface === "wizard") {
          const page = () => Page({ params: Promise.resolve({ id: input.documentId }), searchParams: Promise.resolve({}) });
          if (visible) assert.ok(await page());
          else await assert.rejects(page(), /NEXT_HTTP_ERROR_FALLBACK;404/);
        } else {
          const tool = PAYROLL_TOOLS.find((entry) => entry.name === (surface === "assistant list" ? "list_pay_runs" : "get_pay_run"))!;
          const result = await tool.execute({ documentId: input.documentId }, state.gate!);
          if (surface === "assistant detail") assert.equal(result.ok, visible);
          else {
            assert.ok(result.ok);
            assert.equal((result.data as { returned: number }).returned, visible ? 1 : 0);
          }
        }
      };
      await read(false);
      state.gate = { ...gate, allowedSubsidiaryIds: null };
      await read(true);
      state.gate = { ...gate, allowedSubsidiaryIds: new Set([fx.subsidiaryId, childId]) };
      await read(true);
    } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
  });
}

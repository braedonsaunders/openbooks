import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * SOV creation fences scheduledValue to the numeric(19,4) width but passes
 * sortOrder through Number() straight into the integer column — and the
 * route rethrows unknown errors. An out-of-int32 sort figure dies in
 * Postgres as a raw integer failure (HTTP 500) instead of failing closed
 * with a named 422 and nothing written.
 * sov_lines.sort_order is integer DEFAULT 0 NOT NULL.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __sovSortState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__sovSortState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null; }
      `);
    if (specifier.endsWith("/lib/projects-gate")) return virtual("export async function guardProjectsFeature() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === "schedule_of_values")!;
  const typeId = randomUUID();
  const projectId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'sov sort fixture')`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
    values (${projectId},${org.orgId},${org.subsidiaryId},'SOVSORT','SOV sort job',${org.customerId},${typeId},'active',true)`));
  return { org, projectId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://construction.test/api/construction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function lineCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from sov_lines where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("addSov refuses an out-of-int32 sort order without writing", { skip: !DB }, async () => {
  const { org, projectId } = await fixture();
  try {
    const response = await post({
      action: "addSov", projectId, description: "Probe line", scheduledValue: "1000",
      incomeAccountId: org.accounts.revenue, sortOrder: 99999999999999999999,
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.notEqual(response.status, 500, `expected a named error, got 500: ${JSON.stringify(json)}`);
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await lineCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("addSov still files an ordinarily sorted line", { skip: !DB }, async () => {
  const { org, projectId } = await fixture();
  try {
    const response = await post({
      action: "addSov", projectId, description: "Probe line", scheduledValue: "1000",
      incomeAccountId: org.accounts.revenue, sortOrder: 3,
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await lineCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

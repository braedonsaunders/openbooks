import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Billing-request creation canonicalizes drawAmount to 4dp shape but never
 * bounds its magnitude, and passes startDate/cutoffDate to the date columns
 * with no validation at all — so a pasted 20-digit draw or a non-calendar
 * date sails through every named check and dies in Postgres, surfacing the
 * raw driver failure instead of failing closed with a named error and
 * nothing written. draw_amount is numeric(19,4); start/cutoff are date.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __billingRequestBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__billingRequestBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.endsWith("/lib/projects-gate")) return virtual("export async function guardProjectsFeature() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const projectId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
    values (${projectId},${org.orgId},${org.subsidiaryId},'BILLBOUND','Bound billing',${org.customerId},'active',true)`));
  return { org, projectId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://billing.test/api/billing-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function requestCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from billing_requests where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("billing-request creation refuses a draw wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org, projectId } = await fixture();
  try {
    const response = await post({
      projectId, basis: "draw_amount", drawAmount: "99999999999999999999.99", cutoffDate: "2026-08-15",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /Failed query|invalid input syntax|numeric field overflow/i);
    assert.equal(await requestCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("billing-request creation refuses a non-calendar cutoff date without writing", { skip: !DB }, async () => {
  const { org, projectId } = await fixture();
  try {
    const response = await post({
      projectId, basis: "draw_amount", drawAmount: "100", cutoffDate: "2026-09-31",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /Failed query|invalid input syntax/i);
    assert.equal(await requestCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("billing-request creation refuses a decimal-comma draw with the dotted rewrite", { skip: !DB }, async () => {
  // B3-SAL-01: '12,34' is twelve-thirty-four written correctly in seven
  // installed locales — stripping the comma would post 1234, a 100x error.
  // The house classifier names the dotted rewrite instead of the generic
  // 'must be an exact decimal', and the dotted figure files normally.
  const { org, projectId } = await fixture();
  try {
    const refused = await post({
      projectId, basis: "draw_amount", drawAmount: "12,34", cutoffDate: "2026-08-15",
    });
    const refusedJson = (await refused.json().catch(() => null)) as { error?: string } | null;
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refusedJson)}`);
    assert.match(refusedJson?.error ?? "", /must use "\." as the decimal point/);
    assert.match(refusedJson?.error ?? "", /write "12,34" as "12\.34"/);
    assert.equal(await requestCount(org.orgId), 0);

    const filed = await post({
      projectId, basis: "draw_amount", drawAmount: "12.34", cutoffDate: "2026-08-15",
    });
    assert.equal(filed.status, 200, JSON.stringify(await filed.json().catch(() => null)));
    assert.equal(await requestCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("billing-request creation still files an ordinary draw request", { skip: !DB }, async () => {
  const { org, projectId } = await fixture();
  try {
    const response = await post({
      projectId, basis: "draw_amount", drawAmount: "100", cutoffDate: "2026-08-15",
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await requestCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Overhead publish shape-checks explicit $/hr rates with canonicalDecimal
 * (4dp) but never fences whole-digit width — so a pasted 20-digit rate
 * sails through the non-negative check and dies in Postgres on the
 * overhead_rates insert, surfacing the raw driver failure (a 500 throw past
 * the 22P02/23503 mapper, since numeric overflow is 22003) instead of
 * failing closed with a named 400 and nothing written. rate_percent is
 * numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __overheadBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__overheadBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(): Promise<{ orgId: string; departmentId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`),
  );
  const departmentId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`insert into departments (id, org_id, code, name, created_by, updated_by) values (${departmentId}, ${org.orgId}, 'FIELD', 'Field Ops', ${actorId}, ${actorId})`),
  );
  return { orgId: org.orgId, departmentId };
}

const post = (ratePerHour: string, departmentId: string) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://overhead.test/api/admin/setup/overhead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          effectiveFrom: "2026-07-01",
          rates: [{ departmentId, ratePerHour }],
        }),
      }),
    ),
  );

async function rateCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from overhead_rates where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("overhead publish refuses a rate wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { orgId, departmentId } = await fixture();
  try {
    const response = await post("99999999999999999999.99", departmentId);
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    assert.equal(await rateCount(orgId), 0);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("overhead publish still publishes an ordinary rate", { skip: !DB }, async () => {
  const { orgId, departmentId } = await fixture();
  try {
    const response = await post("85.50", departmentId);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await rateCount(orgId), 1);
  } finally {
    await dropScratchOrg(orgId);
  }
});

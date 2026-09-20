import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Waiver PATCH casts throughDate to date with only presence checks and
 * fences amount only to 4dp shape, while sign stamps signedAt raw — so a
 * September 31, a pasted 20-digit amount, or a junk signed date sail
 * through every named check and die in Postgres, surfacing the raw driver
 * failure as the 400 body instead of failing closed with a named error and
 * nothing written. through_date is date; amount is numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __lienWaiverPatchBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__lienWaiverPatchBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PATCH } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(): Promise<{ orgId: string; waiverId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true, "projects": true}}'::jsonb where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  const projectId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${projectId},${org.orgId},${org.subsidiaryId},'WAIVER','Waiver project',${org.customerId},'active',true,'{}'::jsonb)`));
  const waiverId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into lien_waivers (org_id, waiver_number, direction, party_id, project_id, waiver_type, through_date, amount, currency, created_by, updated_by)
    values (${org.orgId}, 'W-1', 'received', ${partyId}, ${projectId}, 'conditional_progress', '2026-03-31', '1000.00', 'CAD', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { orgId: org.orgId, waiverId };
}

const patch = (waiverId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://waiver.test/api/compliance/lien-waivers/${waiverId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: waiverId }) },
    ),
  );

async function waiverOf(orgId: string, waiverId: string) {
  const rows = (await withBypassContext(() =>
    db.execute<{ through_date: string; amount: string; status: string }>(
      sql`select through_date::text as through_date, amount::text as amount, status from lien_waivers where org_id = ${orgId} and id = ${waiverId}`,
    ))).rows;
  return rows[0]!;
}

test("waiver update refuses a non-calendar through date without writing", { skip: !DB }, async () => {
  const { orgId, waiverId } = await fixture();
  try {
    const response = await patch(waiverId, { action: "update", throughDate: "2026-09-31" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal((await waiverOf(orgId, waiverId)).through_date, "2026-03-31");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("waiver update refuses an amount wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { orgId, waiverId } = await fixture();
  try {
    const response = await patch(waiverId, { action: "update", amount: "99999999999999999999.99" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    assert.equal(Number((await waiverOf(orgId, waiverId)).amount), 1000);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("waiver sign refuses a non-calendar signed date without writing", { skip: !DB }, async () => {
  const { orgId, waiverId } = await fixture();
  try {
    const response = await patch(waiverId, { action: "sign", signedByName: "Jane Doe", signedAt: "not-a-date" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal((await waiverOf(orgId, waiverId)).status, "draft");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("waiver update still saves an ordinary edit", { skip: !DB }, async () => {
  const { orgId, waiverId } = await fixture();
  try {
    const response = await patch(waiverId, { action: "update", amount: "2000.00" });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number((await waiverOf(orgId, waiverId)).amount), 2000);
  } finally {
    await dropScratchOrg(orgId);
  }
});

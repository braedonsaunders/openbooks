import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Waiver creation fences its date window with Date.parse span math, but
 * Date.parse normalises some non-calendar dates (2026-09-31 becomes October
 * 1st),
 * so a non-calendar end date passes every named check and dies in the date
 * column as a raw driver failure instead of failing closed with a named
 * error and nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __waiverDateState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__waiverDateState;
          return { user: { orgId: s.orgId, id: s.actorId } };
        }
      `);
    if (specifier.endsWith("/lib/compliance")) return virtual("export async function guardComplianceFeature() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true}}'::jsonb where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, partyId, requirementId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://waiver.test/api/compliance/waivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function waiverCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from compliance_waivers where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("waiver creation refuses a non-calendar end date without writing", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId,
      requirementId,
      reason: "Carrier renewal delayed by underwriter backlog",
      expiresOn: "2026-09-31",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /end date/i, `expected a named date error, got: ${JSON.stringify(json)}`);
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("waiver creation still grants a calendar-dated exception", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId,
      requirementId,
      reason: "Carrier renewal delayed by underwriter backlog",
      effectiveFrom: "2026-01-05",
      expiresOn: "2026-02-27",
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await waiverCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * No exception may be requested for a vendor — or under a project — the
 * caller cannot see. A subsidiary-restricted request against either reads as
 * 404 and writes nothing; missing and hidden are indistinguishable, so the
 * refusal never oracles which ids exist elsewhere.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "", allowedSubsidiaryIds: null as ReadonlySet<string> | null };
Object.assign(globalThis, { __complianceWaiverScopeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__complianceWaiverScopeState;
          return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowedSubsidiaryIds };
        }
        export function guardSubsidiaryScope(authz, subsidiaryId, options) {
          const allowed = authz.allowedSubsidiaryIds;
          if (allowed === null) return null;
          const orgWideNull = options !== undefined && options !== null && options.orgWideNull === true;
          if ((subsidiaryId === null || subsidiaryId === undefined) && orgWideNull) return null;
          if (typeof subsidiaryId === "string" && allowed.has(subsidiaryId)) return null;
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        }
      `);
    if (specifier.endsWith("/lib/compliance"))
      return virtual(`export async function guardComplianceFeature() { return null }`);
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
  const branchId = randomUUID();
  const hiddenPartyId = randomUUID();
  const visiblePartyId = randomUUID();
  const hiddenProjectId = randomUUID();
  const visibleProjectId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${hiddenPartyId},${org.orgId},'vendor','Hidden vendor',${branchId},true,'{}'::jsonb),
           (${visiblePartyId},${org.orgId},'vendor','Visible vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${hiddenProjectId},${org.orgId},${branchId},'HID','Hidden project',${org.customerId},'active',true,'{}'::jsonb),
           (${visibleProjectId},${org.orgId},${org.subsidiaryId},'VIS','Visible project',${org.customerId},'active',true,'{}'::jsonb)`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, hiddenPartyId, visiblePartyId, hiddenProjectId, visibleProjectId, requirementId };
}

const VALID = {
  reason: "Carrier renewal delayed by underwriter backlog",
  effectiveFrom: "2026-06-01",
  expiresOn: "2026-08-01",
};

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://waivers.test/api/compliance/waivers", {
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

test("waiver creation cannot grant an exception to a hidden vendor", { skip: !DB }, async () => {
  const { org, hiddenPartyId, visibleProjectId, requirementId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await post({ partyId: hiddenPartyId, projectId: visibleProjectId, requirementId, ...VALID });
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("waiver creation cannot grant an exception under a hidden project", { skip: !DB }, async () => {
  const { org, visiblePartyId, hiddenProjectId, requirementId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await post({ partyId: visiblePartyId, projectId: hiddenProjectId, requirementId, ...VALID });
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("waiver creation still files in-scope exception requests", { skip: !DB }, async () => {
  const { org, visiblePartyId, visibleProjectId, requirementId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await post({ partyId: visiblePartyId, projectId: visibleProjectId, requirementId, ...VALID });
    const json = (await response.json().catch(() => null)) as { status?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.status, "pending_approval");
    assert.equal(await waiverCount(org.orgId), 1);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Revoking a hidden-entity exception must read as 404 and touch nothing: a
 * subsidiary-restricted revocation against another entity's vendor — or
 * under another entity's project — is refused before the revocation runs,
 * and missing and hidden are indistinguishable.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "", allowedSubsidiaryIds: null as ReadonlySet<string> | null };
Object.assign(globalThis, { __complianceWaiverDeleteScopeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__complianceWaiverDeleteScopeState;
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
const { DELETE } = await import("./route.ts");
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
  const waiverFor = async (partyId: string, projectId: string) =>
    (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into compliance_waivers
        (org_id, party_id, requirement_id, project_id, reason, effective_from, expires_on,
         requested_by, approved_by, created_by, updated_by)
      values (${org.orgId}, ${partyId}, ${requirementId}, ${projectId},
              'approved test exception', '2026-06-01', '2026-08-01',
              ${actorId}, ${actorId}, ${actorId}, ${actorId})
      returning id`))).rows[0]!.id;
  return {
    org,
    hiddenWaiverId: await waiverFor(hiddenPartyId, visibleProjectId),
    hiddenProjectWaiverId: await waiverFor(visiblePartyId, hiddenProjectId),
    visibleWaiverId: await waiverFor(visiblePartyId, visibleProjectId),
  };
}

const revoke = (id: string) =>
  withOrgContext(state.orgId, () =>
    DELETE(
      new Request(`http://waivers.test/api/compliance/waivers/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "restricted revocation attempt" }),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );

async function revokedAt(id: string): Promise<string | null> {
  const rows = (await withBypassContext(() =>
    db.execute<{ revoked_at: string | null }>(sql`select revoked_at from compliance_waivers where id = ${id}`))).rows;
  return rows[0]!.revoked_at;
}

test("revocation cannot revoke a hidden-entity exception", { skip: !DB }, async () => {
  const { org, hiddenWaiverId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await revoke(hiddenWaiverId);
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await revokedAt(hiddenWaiverId), null);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("revocation cannot revoke an exception under a hidden project", { skip: !DB }, async () => {
  const { org, hiddenProjectWaiverId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await revoke(hiddenProjectWaiverId);
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await revokedAt(hiddenProjectWaiverId), null);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("revocation still revokes in-scope exceptions", { skip: !DB }, async () => {
  const { org, visibleWaiverId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await revoke(visibleWaiverId);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.notEqual(await revokedAt(visibleWaiverId), null);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

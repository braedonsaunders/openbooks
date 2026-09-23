import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * A certificate belonging to another entity must read as 404 to a
 * subsidiary-restricted caller no matter which action or revision they name:
 * editing, verifying, rejecting or reopening a hidden record is refused
 * before any lifecycle or concurrency check, so the refusal never oracles
 * what the caller cannot see.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "", allowedSubsidiaryIds: null as ReadonlySet<string> | null };
Object.assign(globalThis, { __compliancePatchScopeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__compliancePatchScopeState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: s.allowedSubsidiaryIds };
        }
        export function can() { return true }
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
const { PATCH } = await import("./route.ts");
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
  const classId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${hiddenPartyId},${org.orgId},'vendor','Hidden vendor',${branchId},true,'{}'::jsonb),
           (${visiblePartyId},${org.orgId},'vendor','Visible vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${hiddenPartyId}, ${classId}, ${actorId}, ${actorId}),
           (${org.orgId}, ${visiblePartyId}, ${classId}, ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${hiddenProjectId},${org.orgId},${branchId},'HID','Hidden project',${org.customerId},'active',true,'{}'::jsonb),
           (${visibleProjectId},${org.orgId},${org.subsidiaryId},'VIS','Visible project',${org.customerId},'active',true,'{}'::jsonb)`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, class_id, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', ${classId}, 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const recordFor = async (partyId: string, projectId: string) =>
    (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into compliance_records (org_id, party_id, requirement_id, project_id, effective_from, coverage_amount, created_by, updated_by)
      values (${org.orgId}, ${partyId}, ${requirementId}, ${projectId}, '2026-01-01', '1000000.00', ${actorId}, ${actorId})
      returning id`))).rows[0]!.id;
  return {
    org,
    hiddenRecordId: await recordFor(hiddenPartyId, visibleProjectId),
    hiddenProjectRecordId: await recordFor(visiblePartyId, hiddenProjectId),
    visibleRecordId: await recordFor(visiblePartyId, visibleProjectId),
  };
}

const patch = (recordId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://records.test/api/compliance/records/${recordId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: recordId }) },
    ),
  );

async function coverageOf(recordId: string): Promise<string> {
  const rows = (await withBypassContext(() =>
    db.execute<{ coverage_amount: string }>(sql`select coverage_amount from compliance_records where id = ${recordId}`))).rows;
  return rows[0]!.coverage_amount;
}

const UPDATE = { action: "update", revision: 1, coverageAmount: "2000000.00" };

test("certificate PATCH cannot edit another entity's certificate", { skip: !DB }, async () => {
  const { org, hiddenRecordId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await patch(hiddenRecordId, UPDATE);
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number(await coverageOf(hiddenRecordId)), 1000000);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("certificate PATCH cannot edit a certificate under a hidden project", { skip: !DB }, async () => {
  const { org, hiddenProjectRecordId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await patch(hiddenProjectRecordId, UPDATE);
    assert.equal(response.status, 404, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number(await coverageOf(hiddenProjectRecordId)), 1000000);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

test("certificate PATCH still edits in-scope certificates", { skip: !DB }, async () => {
  const { org, visibleRecordId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await patch(visibleRecordId, UPDATE);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number(await coverageOf(visibleRecordId)), 2000000);
  } finally {
    state.allowedSubsidiaryIds = null;
    await dropScratchOrg(org.orgId);
  }
});

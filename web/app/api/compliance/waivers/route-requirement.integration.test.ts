import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * A waiver POST used to accept any requirementId — inactive, wrong-class or
 * other-org — filing a pending_approval exception that covers nothing while
 * reading as on file. The waiver write now runs the same requirement
 * applicability check as the evidence write, through the shared helper.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __waiverRequirementState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__waiverRequirementState;
          return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null }
      `);
    if (specifier.endsWith("/lib/compliance")) return virtual("export async function guardComplianceFeature() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

const VALID = {
  reason: "Carrier renewal delayed by underwriter backlog",
  effectiveFrom: "2026-06-01",
  expiresOn: "2026-08-01",
};

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true}}'::jsonb where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  const classId = randomUUID();
  const otherClassId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${actorId}, ${actorId}),
           (${otherClassId}, ${org.orgId}, 'SUP', 'Supplier', 'none', '1099-NEC', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${classId}, ${actorId}, ${actorId})`));
  const applicableId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const inactiveId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, is_active, created_by, updated_by)
    values (${org.orgId}, 'OLD', 'Retired requirement', 'insurance', 'block_payment', false, ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const wrongClassId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, class_id, created_by, updated_by)
    values (${org.orgId}, 'SUP-ONLY', 'Supplier requirement', 'insurance', 'block_payment', ${otherClassId}, ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const otherOrg = await withBypassContext(() => createScratchOrg());
  const foreignId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, enforcement, created_by, updated_by)
    values (${otherOrg.orgId}, 'COI', 'Foreign requirement', 'insurance', 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, otherOrg, partyId, applicableId, inactiveId, wrongClassId, foreignId };
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

for (const [label, key] of [["inactive", "inactiveId"], ["wrong-class", "wrongClassId"], ["other-org", "foreignId"]] as const) {
  test(`waiver creation refuses a ${label} requirement without writing`, { skip: !DB }, async () => {
    const { org, otherOrg, partyId, ...ids } = await fixture();
    try {
      const response = await post({ partyId, requirementId: ids[key], ...VALID });
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
      assert.match(json?.error ?? "", /does not apply to this vendor/, `expected a named refusal, got: ${JSON.stringify(json)}`);
      assert.equal(await waiverCount(org.orgId), 0);
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(otherOrg.orgId);
    }
  });
}

test("waiver creation still files against an applicable requirement", { skip: !DB }, async () => {
  const { org, otherOrg, partyId, applicableId } = await fixture();
  try {
    const response = await post({ partyId, requirementId: applicableId, ...VALID });
    const json = (await response.json().catch(() => null)) as { status?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.status, "pending_approval");
    assert.equal(await waiverCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(otherOrg.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * F-t04-003 (overlay path): /entities + /parties loaders supply the vendor
 * Compliance tab inputs, but GET /api/parties/[id]/drawer — the shell
 * overlay's payload — answered no compliance fields, so the overlay vendor
 * drawer could never offer the tab. The route must return complianceEnabled,
 * canManageCompliance, and the vendor's class payload (vendors only,
 * feature on); anything else answers compliance: null.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __drawerComplianceState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__drawerComplianceState;
          return { user: { orgId: s.orgId, id: s.actorId, roles: [] }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null; }
        export function can() { return true; }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { GET } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(featureOn: boolean): Promise<{ orgId: string; partyId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const partyId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'company','Overlay vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${partyId}, true, ${actorId}, ${actorId})`));
  if (featureOn) {
    await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"subcontractorCompliance":true}'::jsonb) where id=${org.orgId}`));
  }
  return { orgId: org.orgId, partyId };
}

const get = (partyId: string, role?: string) =>
  GET(
    new Request(`http://localhost/api/parties/${partyId}/drawer${role ? `?role=${role}` : ""}`),
    { params: Promise.resolve({ id: partyId }) },
  );

test("the overlay drawer payload carries the Compliance tab inputs (F-t04-003)", { skip: !DB }, async () => {
  const { orgId, partyId } = await fixture(true);
  try {
    const res = await get(partyId, "vendor");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      complianceEnabled: unknown;
      canManageCompliance: unknown;
      compliance: { classId: unknown; classes: unknown } | null;
    };
    assert.equal(body.complianceEnabled, true);
    assert.equal(body.canManageCompliance, true);
    assert.ok(body.compliance, "a feature-on vendor must get the compliance payload");
    assert.equal(body.compliance.classId, null);
    assert.ok(Array.isArray(body.compliance.classes), "the class list must ride along");
  } finally {
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

test("the overlay drawer payload omits compliance when the feature is off (F-t04-003)", { skip: !DB }, async () => {
  const { orgId, partyId } = await fixture(false);
  try {
    const res = await get(partyId, "vendor");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complianceEnabled: unknown; compliance: unknown };
    assert.equal(body.complianceEnabled, false);
    assert.equal(body.compliance, null);
  } finally {
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Vendor compliance PATCH fences every enum and the TIN strictly, but the
 * two boolean toggles ride straight into coalesce() against boolean columns
 * with no type check — a non-boolean rides to Postgres and dies there,
 * surfacing the raw driver failure through the catch instead of failing
 * closed with a named error and nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __vendorBooleanState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__vendorBooleanState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope(authz) {
          if (authz.allowedSubsidiaryIds === null) return null;
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
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
const { PATCH } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const partyId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Boolean vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, information_return_form, tax_classification,
      tin_encrypted, tin_last4, tin_type, backup_withholding, is_t4a, created_by, updated_by)
    values (${org.orgId}, ${partyId}, '1099-MISC', 'individual',
      'sealed-original', '0000', 'ssn', false, false, ${actorId}, ${actorId})`));
  return { org, partyId };
}

const patch = (partyId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://vendor.test/api/compliance/vendors/${partyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ partyId }) },
    ),
  );

async function flags(partyId: string): Promise<{ backup: boolean; reportable: boolean }> {
  const rows = (await withBypassContext(() => db.execute<{ backup_withholding: boolean; is_t4a: boolean }>(sql`
    select backup_withholding, is_t4a from vendor_roles where party_id = ${partyId}`))).rows;
  return { backup: rows[0]!.backup_withholding, reportable: rows[0]!.is_t4a };
}

test("vendor PATCH refuses a non-boolean toggle without writing", { skip: !DB }, async () => {
  const { org, partyId } = await fixture();
  try {
    const response = await patch(partyId, { backupWithholding: "maybe" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /backupwithholding/i, `expected a named toggle error, got: ${JSON.stringify(json)}`);
    assert.deepEqual(await flags(partyId), { backup: false, reportable: false });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("vendor PATCH still flips a real boolean toggle", { skip: !DB }, async () => {
  const { org, partyId } = await fixture();
  try {
    const response = await patch(partyId, { backupWithholding: true, reportable: true });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.deepEqual(await flags(partyId), { backup: true, reportable: true });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

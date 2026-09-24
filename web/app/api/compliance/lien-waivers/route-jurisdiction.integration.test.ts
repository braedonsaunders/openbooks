import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The waiver jurisdiction was stored as free text — never validated, never
 * evaluated — so a wrong-state waiver released payment. It is now an
 * ISO 3166-2 subdivision code: unknown codes refuse with a named 422, and
 * the evaluator matches the waiver against the project's site.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __lienWaiverJurisdictionState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__lienWaiverJurisdictionState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null }
      `);
    // The real @/lib/compliance loads: the fixture enables subcontractorCompliance.
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const { PATCH } = await import("./[id]/route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
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
  return { org, partyId, projectId };
}

const base = (partyId: string, projectId: string) => ({
  partyId, projectId, waiverType: "conditional_progress",
  throughDate: "2026-03-31", amount: "1000.00", currency: "CAD",
});

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://waiver.test/api/compliance/lien-waivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

const patch = (id: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://waiver.test/api/compliance/lien-waivers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );

async function waiverJurisdiction(waiverId: string): Promise<string | null> {
  const rows = (await withBypassContext(() => db.execute<{ jurisdiction: string | null }>(sql`
    select jurisdiction from lien_waivers where id = ${waiverId}`))).rows;
  return rows[0]!.jurisdiction;
}

test("waiver creation refuses an unknown jurisdiction without writing", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const response = await post({ ...base(partyId, projectId), jurisdiction: "Atlantis" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /unknown jurisdiction/, `expected a named refusal, got: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /ISO 3166-2/, `expected the remedy, got: ${JSON.stringify(json)}`);
    const count = (await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from lien_waivers where org_id = ${org.orgId}`))).rows[0]!.n;
    assert.equal(count, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("waiver creation canonicalises a known jurisdiction and stores it", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const response = await post({ ...base(partyId, projectId), jurisdiction: "us-ca" });
    const json = (await response.json().catch(() => null)) as { id?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(await waiverJurisdiction(json!.id!), "US-CA");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("waiver update refuses an unknown jurisdiction and canonicalises a known one", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const created = (await (await post(base(partyId, projectId))).json()) as { id: string };
    const refused = await patch(created.id, { jurisdiction: "XX-YY" });
    assert.equal(refused.status, 422, JSON.stringify(await refused.json().catch(() => null)));
    assert.equal(await waiverJurisdiction(created.id), null);
    const updated = await patch(created.id, { jurisdiction: "us-ny" });
    assert.equal(updated.status, 200, JSON.stringify(await updated.json().catch(() => null)));
    assert.equal(await waiverJurisdiction(created.id), "US-NY");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Compliance-record creation passes effectiveFrom/expiresOn to the date
 * columns raw and fences coverage figures only to 4dp shape, so a
 * non-calendar date or a pasted 20-digit figure sails through every named
 * check and dies in Postgres — surfacing the raw driver failure through the
 * catch instead of failing closed with a named error and nothing written.
 * effective_from/expires_on are date; coverage_amount/aggregate_amount are
 * numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __complianceRecordBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__complianceRecordBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
        }
        // Subsidiary fencing is covered by the dedicated scope tests with a
        // restricted fence; this double stays unrestricted so the bounds
        // tests keep testing bounds.
        export function guardSubsidiaryScope() { return null };
      `);
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
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true}}'::jsonb where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  const classId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Record vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${classId}, ${actorId}, ${actorId})`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, class_id, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', ${classId}, 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, partyId, requirementId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://records.test/api/compliance/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function recordCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from compliance_records where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("record creation refuses a non-calendar effective date without writing", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-09-31", expiresOn: "2026-10-15",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /effectivefrom/i, `expected a named date error, got: ${JSON.stringify(json)}`);
    assert.equal(await recordCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record creation refuses a coverage figure wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      coverageAmount: "99999999999999999999.99",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await recordCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record creation still files an ordinary certificate", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      coverageAmount: "1000000.00",
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await recordCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Certificate PATCH casts effectiveFrom/expiresOn to date with no validation
 * at all and fences coverage figures only to 4dp shape — so a September 31
 * or a pasted 20-digit coverage amount sails through every named check and
 * dies in Postgres, surfacing the raw driver failure as the 400 body
 * instead of failing closed with a named error and nothing written.
 * effective_from/expires_on are date; coverage_amount/aggregate_amount are
 * numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __compliancePatchBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__compliancePatchBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function can() { return true }
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

async function fixture(): Promise<{ orgId: string; recordId: string }> {
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
  const recordId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_records (org_id, party_id, requirement_id, effective_from, coverage_amount, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${requirementId}, '2026-01-01', '1000000.00', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { orgId: org.orgId, recordId };
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

async function coverageOf(orgId: string, recordId: string): Promise<string | null> {
  const rows = (await withBypassContext(() =>
    db.execute<{ coverage_amount: string | null }>(
      sql`select coverage_amount from compliance_records where org_id = ${orgId} and id = ${recordId}`,
    ))).rows;
  return rows[0]?.coverage_amount ?? null;
}

test("certificate update refuses a non-calendar effective date without writing", { skip: !DB }, async () => {
  const { orgId, recordId } = await fixture();
  try {
    const response = await patch(recordId, { action: "update", effectiveFrom: "2026-09-31" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(Number(await coverageOf(orgId, recordId)), 1000000);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("certificate update refuses a coverage amount wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { orgId, recordId } = await fixture();
  try {
    const response = await patch(recordId, { action: "update", coverageAmount: "99999999999999999999.99" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    assert.equal(Number(await coverageOf(orgId, recordId)), 1000000);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("certificate update still saves an ordinary amount", { skip: !DB }, async () => {
  const { orgId, recordId } = await fixture();
  try {
    const response = await patch(recordId, { action: "update", coverageAmount: "2000000.00" });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(Number(await coverageOf(orgId, recordId)), 2000000);
  } finally {
    await dropScratchOrg(orgId);
  }
});

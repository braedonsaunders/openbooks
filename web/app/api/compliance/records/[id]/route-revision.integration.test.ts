import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Certificate PATCH read its row before opening a transaction and rewrote it
 * with no version check, so two concurrent edits silently lost one writer's
 * changes and the audit logged a stale before-image. PATCH now locks the row
 * first, requires the caller to echo the revision it read (409 when stale),
 * bumps the counter on every applied change, and verification records the
 * exact revision it attested.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __compliancePatchRevisionState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__compliancePatchRevisionState;
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
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PATCH } = await import("./route.ts");
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
  const recordId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_records (org_id, party_id, requirement_id, effective_from, coverage_amount, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${requirementId}, '2026-01-01', '1000000.00', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, recordId };
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

async function rowOf(recordId: string) {
  const rows = (await withBypassContext(() =>
    db.execute<{ revision: number; verified_revision: number | null; issuer_name: string | null; status: string }>(
      sql`select revision, verified_revision, issuer_name, status from compliance_records where id = ${recordId}`,
    ))).rows;
  return rows[0]!;
}

test("certificate PATCH without a revision is refused without writing", { skip: !DB }, async () => {
  const { org, recordId } = await fixture();
  try {
    const response = await patch(recordId, { action: "update", coverageAmount: "2000000.00" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /revision/i);
    assert.equal((await rowOf(recordId)).revision, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale revision is refused and the winner's write survives", { skip: !DB }, async () => {
  const { org, recordId } = await fixture();
  try {
    const first = await patch(recordId, { action: "update", revision: 1, issuerName: "First Writer" });
    assert.equal(first.status, 200, JSON.stringify(await first.json().catch(() => null)));
    const loser = await patch(recordId, { action: "update", revision: 1, issuerName: "Stale Writer" });
    const json = (await loser.json().catch(() => null)) as { error?: string } | null;
    assert.equal(loser.status, 409, `expected 409, got ${loser.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /reload/i);
    const row = await rowOf(recordId);
    assert.equal(row.issuer_name, "First Writer");
    assert.equal(row.revision, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("verification names the revision it attested", { skip: !DB }, async () => {
  const { org, recordId } = await fixture();
  try {
    state.actorId = await withBypassContext(() => createScratchUser(org.orgId, "Verifier", "compliance_manager"));
    const response = await patch(recordId, { action: "verify", revision: 1 });
    const json = (await response.json().catch(() => null)) as { revision?: number } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json?.revision, 2);
    const row = await rowOf(recordId);
    assert.equal(row.status, "active");
    assert.equal(row.verified_revision, 1);
    assert.equal(row.revision, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * A renewal names its predecessor through supersedesId. Before this fix a
 * malformed id fell through the isUuid guard and an unmatched one matched
 * zero rows, and either way the POST still returned {id} with an audit row
 * describing a supersession that never happened. Both now refuse before any
 * write; a genuine renewal still files.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __complianceRecordSupersedeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__complianceRecordSupersedeState;
          return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
        }
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
  const otherPartyId = randomUUID();
  const classId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor','Record vendor',${org.subsidiaryId},true,'{}'::jsonb),
           (${otherPartyId},${org.orgId},'vendor','Other vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into compliance_classes (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${classId}, ${actorId}, ${actorId}),
           (${org.orgId}, ${otherPartyId}, ${classId}, ${actorId}, ${actorId})`));
  const requirementId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_requirements (org_id, code, name, category, class_id, enforcement, created_by, updated_by)
    values (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', ${classId}, 'block_payment', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const priorId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_records (org_id, party_id, requirement_id, status, effective_from, expires_on, created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${requirementId}, 'active', '2026-01-01', '2026-12-31', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  const otherPriorId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into compliance_records (org_id, party_id, requirement_id, status, effective_from, expires_on, created_by, updated_by)
    values (${org.orgId}, ${otherPartyId}, ${requirementId}, 'active', '2026-01-01', '2026-12-31', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, partyId, requirementId, priorId, otherPriorId };
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

async function recordStatus(id: string): Promise<string> {
  const rows = (await withBypassContext(() =>
    db.execute<{ status: string }>(sql`select status from compliance_records where id = ${id}`))).rows;
  return rows[0]!.status;
}

test("record creation refuses a malformed supersedesId without writing", { skip: !DB }, async () => {
  const { org, partyId, requirementId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      supersedesId: "not-a-uuid",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /supersedesId/i);
    assert.equal(await recordCount(org.orgId), 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record creation refuses an unmatched supersedesId without writing", { skip: !DB }, async () => {
  const { org, partyId, requirementId, priorId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      supersedesId: randomUUID(),
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /supersedesId/i);
    assert.equal(await recordCount(org.orgId), 2);
    assert.equal(await recordStatus(priorId), "active");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record creation refuses another vendor's certificate as supersedesId", { skip: !DB }, async () => {
  const { org, partyId, requirementId, priorId, otherPriorId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      supersedesId: otherPriorId,
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await recordCount(org.orgId), 2);
    assert.equal(await recordStatus(priorId), "active");
    assert.equal(await recordStatus(otherPriorId), "active");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record creation still files a genuine renewal", { skip: !DB }, async () => {
  const { org, partyId, requirementId, priorId } = await fixture();
  try {
    const response = await post({
      partyId, requirementId, effectiveFrom: "2026-07-20", expiresOn: "2026-10-15",
      supersedesId: priorId,
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await recordCount(org.orgId), 3);
    assert.equal(await recordStatus(priorId), "superseded");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

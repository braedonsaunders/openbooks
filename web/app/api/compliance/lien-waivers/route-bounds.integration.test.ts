import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Lien-waiver creation passes throughDate to the date column raw and fences
 * amount only to 4dp shape, so a non-calendar through date or a pasted
 * 20-digit amount sails through every named check and dies in Postgres —
 * surfacing the raw driver failure through the catch instead of failing
 * closed with a named error and nothing written.
 * through_date is date NOT NULL; amount is numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __lienWaiverBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__lienWaiverBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
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

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://waiver.test/api/compliance/lien-waivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function waiverCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from lien_waivers where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("lien-waiver creation refuses a non-calendar through date without writing", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const base = { partyId, projectId, waiverType: "conditional_progress", amount: "1000.00", currency: "CAD" };
    const response = await post({ ...base, throughDate: "2026-09-31" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /throughdate/i, `expected a named date error, got: ${JSON.stringify(json)}`);
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lien-waiver creation refuses an amount wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const response = await post({
      partyId, projectId, waiverType: "conditional_progress",
      throughDate: "2026-03-31", amount: "99999999999999999999.99", currency: "CAD",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lien-waiver creation refuses a decimal-comma amount with the dotted rewrite", { skip: !DB }, async () => {
  // B3-SAL-01: '12,34' is twelve-thirty-four written correctly in seven
  // installed locales — stripping the comma would release 1234, a 100x error.
  const { org, partyId, projectId } = await fixture();
  try {
    const refused = await post({
      partyId, projectId, waiverType: "conditional_progress",
      throughDate: "2026-03-31", amount: "12,34", currency: "CAD",
    });
    const refusedJson = (await refused.json().catch(() => null)) as { error?: string } | null;
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refusedJson)}`);
    assert.match(refusedJson?.error ?? "", /must use "\." as the decimal point/);
    assert.equal(await waiverCount(org.orgId), 0);
    const filed = await post({
      partyId, projectId, waiverType: "conditional_progress",
      throughDate: "2026-03-31", amount: "12.34", currency: "CAD",
    });
    assert.equal(filed.status, 200, JSON.stringify(await filed.json().catch(() => null)));
    assert.equal(await waiverCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lien-waiver creation refuses an unknown currency without writing", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const base = { partyId, projectId, waiverType: "conditional_progress", throughDate: "2026-03-31", amount: "1000.00" };
    const response = await post({ ...base, currency: "XX" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /ISO 4217/, `expected a named currency error, got: ${JSON.stringify(json)}`);
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lien-waiver creation refuses a lowercase code without writing", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const response = await post({
      partyId, projectId, waiverType: "conditional_progress",
      throughDate: "2026-03-31", amount: "1000.00", currency: "cad",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /uppercase/, `expected a named currency error, got: ${JSON.stringify(json)}`);
    assert.equal(await waiverCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lien-waiver creation still files an ordinary waiver", { skip: !DB }, async () => {
  const { org, partyId, projectId } = await fixture();
  try {
    const response = await post({
      partyId, projectId, waiverType: "conditional_progress",
      throughDate: "2026-03-31", amount: "1000.00", currency: "CAD",
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await waiverCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

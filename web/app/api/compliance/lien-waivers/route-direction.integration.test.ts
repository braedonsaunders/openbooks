import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Lien-waiver creation must not silently coerce the waiver direction.
 * `direction` decides whose claim is released, but any value other than the
 * exact string 'issued' — a typo, wrong case, trailing whitespace — was
 * stored as 'received'. A caller asking to issue a waiver could file the
 * opposite instrument without any error.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __lienWaiverRouteUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/compliance/lien-waivers/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__lienWaiverRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST: create } = await import("./route");

const json = (body: unknown) =>
  new Request("http://audit.local/api/compliance/lien-waivers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function directionOf(orgId: string, id: string): Promise<string | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ direction: string }>(sql`select direction from lien_waivers where id = ${id} and org_id = ${orgId}`),
  );
  return r.rows[0]?.direction;
}

async function waiverCount(orgId: string): Promise<number> {
  const r = await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from lien_waivers where org_id = ${orgId}`),
  );
  return r.rows[0]!.n;
}

test("lien-waiver creation rejects an unrecognised direction", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true, "projects": true}}'::jsonb where id = ${org.orgId}`),
    );
    const partyId = randomUUID();
    const projectId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${partyId},${org.orgId},'vendor','Waiver vendor',${org.subsidiaryId},true,'{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${projectId},${org.orgId},${org.subsidiaryId},'WAIVER','Waiver project',${org.customerId},'active',true,'{}'::jsonb)`));
    const base = {
      partyId,
      projectId,
      waiverType: "conditional_progress",
      throughDate: "2026-03-31",
      amount: "1000.00",
      currency: "CAD",
    };

    // Controls: the two documented directions keep working, omission still
    // defaults to received.
    for (const [direction, expected] of [["received", "received"], ["issued", "issued"], [undefined, "received"]] as const) {
      const body = { ...base };
      if (direction !== undefined) Object.assign(body, { direction });
      // The route's feature gate reads org settings through the ambient
      // scope, as the middleware provides in production.
      const created = await withOrgContext(org.orgId, () => create(json(body)));
      assert.equal(created.status, 200, `direction ${String(direction)}: ${JSON.stringify(await created.clone().json())}`);
      const { id } = (await created.json()) as { id: string };
      assert.equal(await directionOf(org.orgId, id), expected);
    }

    // The defect: near-miss directions must fail closed, never file the
    // opposite instrument.
    const before = await waiverCount(org.orgId);
    for (const direction of ["issued ", "ISSUED", "Receive", "receivd", 7]) {
      const refused = await withOrgContext(org.orgId, () => create(json({ ...base, direction })));
      assert.equal(refused.status, 400, `direction ${JSON.stringify(direction)} must be rejected`);
    }
    assert.equal(await waiverCount(org.orgId), before, "a refused waiver must not be created");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

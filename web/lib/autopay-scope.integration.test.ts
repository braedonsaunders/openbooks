import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "./auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __autopayScopeSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__autopayScopeSession.user}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const methodsRoute = await import("../app/api/autopay/methods/route");
const policyRoute = await import("../app/api/autopay/policy/route");

test("a subsidiary-restricted collector reads only in-scope customers' cards and cannot rewrite the org-wide retry policy", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const childId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Child entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const rootCustomer = randomUUID();
    const childCustomer = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${rootCustomer}, ${org.orgId}, 'company', 'Root customer', ${org.subsidiaryId}),
             (${childCustomer}, ${org.orgId}, 'company', 'Child customer', ${childId})`);
    const actor = await createScratchUser(org.orgId, "Collector", "collector");
    await db.execute(sql`
      update app_roles set permissions = '["payment_methods.read","payment_methods.manage","autopay.manage"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [childId] })}::jsonb
       where org_id = ${org.orgId} and key = 'collector'`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
             || '{"onlinePayments":true,"autopay":true}'::jsonb, true) where id = ${org.orgId}`);
    session.user = { id: actor, orgId: org.orgId, name: "Collector", email: "collector@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const listMethods = (partyId: string) => withOrgContext(org.orgId, () =>
      (methodsRoute.GET as (request: Request) => Promise<Response>)(new Request(`http://scope.local/api/autopay/methods?partyId=${partyId}`)));

    assert.equal((await listMethods(childCustomer)).status, 200);
    // Another entity's customer answers exactly like a missing one.
    assert.equal((await listMethods(rootCustomer)).status, 404);

    const policy = await withOrgContext(org.orgId, () => (policyRoute.POST as (request: Request) => Promise<Response>)(
      new Request("http://scope.local/api/autopay/policy", {
        method: "POST",
        body: JSON.stringify({ policyId: randomUUID(), retryOffsetsDays: [1, 3], finalAction: "none" }),
      })));
    assert.equal(policy.status, 403);
    assert.match((await policy.json()).error, /requires unrestricted subsidiary access/);
  } finally {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

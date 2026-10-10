import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "./auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __setupLinkSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__setupLinkSession.user}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const methodsRoute = await import("../app/api/autopay/methods/route");
const optionsRoute = await import("../app/api/autopay/methods/setup-options/route");

type Handler = (request: Request) => Promise<Response>;

test("a setup link offers only the customer's addresses and enabled currencies, and refuses anything else before a session exists", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const customer = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, email, subsidiary_id)
      values (${customer}, ${org.orgId}, 'company', 'Northwind Traders', 'ap@northwind.test', ${org.subsidiaryId})`);
    await db.execute(sql`
      insert into contacts (org_id, party_id, name, email, is_primary, is_active)
      values (${org.orgId}, ${customer}, 'Dana Billing', 'dana@northwind.test', true, true),
             (${org.orgId}, ${customer}, 'Former Clerk', 'former@northwind.test', false, false),
             (${org.orgId}, ${customer}, 'Duplicate', 'AP@northwind.test', false, true)`);
    const actor = await createScratchUser(org.orgId, "Collector", "collector");
    await db.execute(sql`
      update app_roles set permissions = '["payment_methods.read","payment_methods.manage"]'::jsonb
       where org_id = ${org.orgId} and key = 'collector'`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
             || '{"onlinePayments":true,"autopay":true,"multiCurrency":false}'::jsonb, true) where id = ${org.orgId}`);
    session.user = { id: actor, orgId: org.orgId, name: "Collector", email: "collector@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

    const optionsResponse = await withOrgContext(org.orgId, () =>
      (optionsRoute.GET as Handler)(new Request(`http://setup.local/api/autopay/methods/setup-options?partyId=${customer}`)));
    assert.equal(optionsResponse.status, 200);
    const options = await optionsResponse.json() as {
      currencies: Array<{ value: string }>;
      defaultCurrency: string | null;
      recipients: Array<{ email: string; source: string }>;
      emailConfigured: boolean;
    };
    assert.deepEqual(options.recipients.map((row) => row.email), ["ap@northwind.test", "dana@northwind.test"],
      "the customer's email and active contacts, each address once; inactive contacts are never offered");
    assert.deepEqual(options.currencies.map((row) => row.value), ["CAD"], "a single-currency organization offers only the entity base currency");
    assert.equal(options.defaultCurrency, "CAD");

    const start = (body: Record<string, unknown>) => withOrgContext(org.orgId, () =>
      (methodsRoute.POST as Handler)(new Request("http://setup.local/api/autopay/methods", {
        method: "POST",
        body: JSON.stringify({ partyId: customer, provider: "stripe", ...body }),
      })));
    const pendingRows = async () => Number((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from customer_payment_methods where org_id = ${org.orgId} and party_id = ${customer}`)).rows[0]?.n ?? 0);

    const foreignCurrency = await start({ currency: "JPY" });
    assert.equal(foreignCurrency.status, 422);
    assert.match((await foreignCurrency.json()).error, /not enabled for this customer/);

    const stranger = await start({ currency: "CAD", recipientEmail: "someone@elsewhere.test" });
    assert.equal(stranger.status, 422);
    assert.match((await stranger.json()).error, /add it to the customer as a contact/);

    if (!options.emailConfigured) {
      const noTransport = await start({ currency: "CAD", recipientEmail: "Dana@Northwind.test" });
      assert.equal(noTransport.status, 422);
      assert.match((await noTransport.json()).error, /Administration → Email/);
    }

    assert.equal(await pendingRows(), 0, "a refused setup never mints a pending payment method");
  } finally {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

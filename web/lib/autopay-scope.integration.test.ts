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
const retryRoute = await import("../app/api/autopay/attempts/[id]/retry/route");

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


test("a shared customer's collection attempt remains private to its invoice entity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const childId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Collector entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const actor = await createScratchUser(org.orgId, "Shared customer collector", "shared_collector");
    await db.execute(sql`
      update app_roles set permissions = '["payment_methods.read","autopay.manage"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [childId] })}::jsonb
       where org_id = ${org.orgId} and key = 'shared_collector'`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"onlinePayments":true,"autopay":true}'::jsonb, true) where id = ${org.orgId}`);
    await db.execute(sql`update parties set subsidiary_id = null where org_id = ${org.orgId} and id = ${org.customerId}`);
    const invoiceId = randomUUID();
    const methodId = randomUUID();
    const enrollmentId = randomUUID();
    const attemptId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id,
        document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-HIDDEN-RETRY', ${org.subsidiaryId},
        ${org.customerId}, '2026-07-15', '2026-07-15', 'CAD', '1', '80', '0', '80', ${actor})`);
    await db.execute(sql`
      insert into customer_payment_methods (id, org_id, party_id, provider, provider_customer_id, provider_method_id,
        is_default, status, created_by, updated_by)
      values (${methodId}, ${org.orgId}, ${org.customerId}, 'stripe', 'cus_shared', 'pm_shared', true, 'active', ${actor}, ${actor})`);
    await db.execute(sql`
      insert into autopay_enrollments (id, org_id, party_id, payment_method_id, status, created_by, updated_by)
      values (${enrollmentId}, ${org.orgId}, ${org.customerId}, ${methodId}, 'active', ${actor}, ${actor})`);
    await db.execute(sql`
      insert into collection_attempts (id, org_id, invoice_id, enrollment_id, payment_method_id, amount, currency,
        provider, status, decline_kind, retry_position, created_by, updated_by)
      values (${attemptId}, ${org.orgId}, ${invoiceId}, ${enrollmentId}, ${methodId}, '80', 'CAD',
        'stripe', 'failed', 'soft', 0, ${actor}, ${actor})`);
    session.user = { id: actor, orgId: org.orgId, name: "Shared customer collector", email: "shared-collector@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const before = (await db.execute(sql`
      select (select count(*)::text from collection_attempts where org_id = ${org.orgId}) as attempts,
        (select count(*)::text from documents where org_id = ${org.orgId}) as documents,
        (select count(*)::text from audit_log where org_id = ${org.orgId}) as audits`)).rows[0];
    const methods = await withOrgContext(org.orgId, () => methodsRoute.GET(new Request(
      `http://scope.local/api/autopay/methods?partyId=${org.customerId}`)));
    assert.equal(methods.status, 200, 'Shared customer methods remain available');
    const retry = (id: string) => withOrgContext(org.orgId, () => retryRoute.POST(new Request(
      `http://scope.local/api/autopay/attempts/${id}/retry`, { method: 'POST' }), { params: Promise.resolve({ id }) }));
    const hidden = await retry(attemptId);
    const missing = await retry(randomUUID());
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    const after = (await db.execute(sql`
      select (select count(*)::text from collection_attempts where org_id = ${org.orgId}) as attempts,
        (select count(*)::text from documents where org_id = ${org.orgId}) as documents,
        (select count(*)::text from audit_log where org_id = ${org.orgId}) as audits`)).rows[0];
    assert.deepEqual(after, before);
  } finally {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

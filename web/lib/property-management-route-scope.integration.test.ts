import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from './auth';

// Same module-hook seam as cash-scope.integration.test.ts: shim server-only,
// resolve `@/` aliases, and let authz.ts read the session from test state so
// the real role/subsidiary resolution runs against the scratch org.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __pmRouteScope: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__pmRouteScope.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { POST } = await import('../app/api/property-management/route');

const NOT_FOUND = { error: 'Property-management record not found' };

interface Fixture {
  orgId: string; actorId: string; subsidiaryId: string; hiddenSubsidiaryId: string;
  propertyId: string; hiddenPropertyId: string; tenantId: string; revenueAccountId: string;
}

async function seed(): Promise<{ org: Awaited<ReturnType<typeof createScratchOrg>>; fx: Fixture }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, 'Property clerk', 'property_clerk');
  await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb,
    subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
    where org_id=${org.orgId} and key='property_clerk'`);
  await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`);
  const hiddenSubsidiaryId = randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hiddenSubsidiaryId},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
  const propertyId = randomUUID(), hiddenPropertyId = randomUUID();
  for (const [id, subsidiaryId, code] of [[propertyId, org.subsidiaryId, 'PRP-SEEN'], [hiddenPropertyId, hiddenSubsidiaryId, 'PRP-HIDDEN']] as const) {
    await db.execute(sql`insert into managed_properties (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency, rent_income_account_id)
      values (${id}, ${org.orgId}, ${subsidiaryId}, ${org.locationId}, ${code}, ${code}, 'commercial', 'active', 'CAD', ${org.accounts.revenue})`);
  }
  return { org, fx: { orgId: org.orgId, actorId, subsidiaryId: org.subsidiaryId, hiddenSubsidiaryId, propertyId, hiddenPropertyId, tenantId: org.customerId, revenueAccountId: org.accounts.revenue } };
}

async function seedLease(fx: Fixture, status: 'draft' | 'active'): Promise<string> {
  const leaseId = randomUUID();
  await db.execute(sql`insert into property_leases (id, org_id, property_id, tenant_id, lease_number, status, starts_on, billing_day, late_fee_type, late_fee_value)
    values (${leaseId}, ${fx.orgId}, ${fx.propertyId}, ${fx.tenantId}, ${`L-${leaseId.slice(0, 8)}`}, ${status}, '2026-01-01', 1, 'fixed', '25')`);
  await db.execute(sql`insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from, income_account_id)
    values (${fx.orgId}, ${leaseId}, 'base_rent', 'Base rent', '1000', 'monthly', '2026-01-01', ${fx.revenueAccountId})`);
  return leaseId;
}

const post = (body: Record<string, unknown>) => POST(new Request('http://openbooks.test/api/property-management', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

function session(fx: Fixture): SessionUser {
  return { id: fx.actorId, orgId: fx.orgId, name: 'Property clerk', email: 'clerk@scratch.test', roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: fx.orgId, homeOrgId: fx.orgId, homeUserId: fx.actorId };
}

test('R8: a restricted caller can assess late fees for one lease inside their subsidiary', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, fx } = await seed();
  try {
    const leaseId = await seedLease(fx, 'active');
    state.user = session(fx);
    const response = await withOrgContext(org.orgId, () => post({ action: 'assessLateFees', leaseId, asOf: '2026-03-01' }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { created: 0 });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('R4: updateLease cannot re-parent a lease into a property outside the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, fx } = await seed();
  try {
    const leaseId = await seedLease(fx, 'draft');
    state.user = session(fx);
    const body = (propertyId: string) => ({
      action: 'updateLease', leaseId, propertyId, tenantId: fx.tenantId, leaseNumber: 'L-SCOPE', startsOn: '2026-01-01', endsOn: null,
      baseRent: '1000', billingDay: 1, paymentTermsDays: 0, securityDepositRequired: '0', camMethod: 'none',
      lateFeeType: 'none', lateFeeValue: '0', graceDays: 0, autoInvoice: true, autoPost: false,
    });
    const currentProperty = () => db.execute<{ property_id: string }>(sql`select property_id::text from property_leases where org_id=${fx.orgId} and id=${leaseId}`)
      .then((r) => r.rows[0]!.property_id);

    const hidden = await withOrgContext(org.orgId, () => post(body(fx.hiddenPropertyId)));
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), NOT_FOUND, 'a hidden target property is indistinguishable from a missing one');
    assert.equal(await currentProperty(), fx.propertyId, 'the lease stays on its visible property');

    const missing = await withOrgContext(org.orgId, () => post(body(randomUUID())));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), NOT_FOUND);

    // Control: the same edit against a visible property goes through.
    const visible = await withOrgContext(org.orgId, () => post(body(fx.propertyId)));
    assert.equal(visible.status, 200, JSON.stringify(await visible.clone().json()));
    assert.equal(await currentProperty(), fx.propertyId);
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

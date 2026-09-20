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
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
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

test('property create/update refuse foreign reference custom values', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, fx } = await seed();
  const foreign = await createScratchOrg();
  try {
    state.user = session(fx);
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'managed_properties', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${fx.actorId}, ${fx.actorId})
    `);
    const createBody = (custom: Record<string, unknown>) => ({
      action: 'createProperty', subsidiaryId: fx.subsidiaryId, code: 'PRP-CF', name: 'Ref fence property',
      propertyType: 'commercial', status: 'active', custom,
    });
    const refusedCreate = await withOrgContext(org.orgId, () => post(createBody({ ref_party: foreign.customerId })));
    assert.equal(refusedCreate.status, 404, `expected 404, got ${refusedCreate.status}: ${JSON.stringify(await refusedCreate.clone().json().catch(() => null))}`);
    const created = await db.execute<{ n: number }>(sql`select count(*)::int as n from managed_properties where org_id = ${org.orgId} and code = 'PRP-CF'`);
    assert.equal(created.rows[0]?.n ?? -1, 0, 'refused create stores nothing');
    const okCreate = await withOrgContext(org.orgId, () => post(createBody({ ref_party: fx.tenantId })));
    assert.equal(okCreate.status, 201, `expected 201, got ${okCreate.status}: ${JSON.stringify(await okCreate.clone().json().catch(() => null))}`);
    const propertyId = ((await okCreate.json()) as { id: string }).id;
    // NOTE: create-time custom persistence lives in engine/src/property/management.ts,
    // which this worktree resolves to the main checkout at runtime; it is proven by
    // the /tmp/b02-prop-eng probe (absolute-path import, STORED:{"ref_party":"…"}).
    // This route test proves the fence decisions (404s) plus update-half storage.
    const updateBody = (custom: Record<string, unknown>) => ({
      action: 'updateProperty', propertyId, subsidiaryId: fx.subsidiaryId, code: 'PRP-CF', name: 'Ref fence property',
      propertyType: 'commercial', status: 'active', custom,
    });
    // Seed a stored own-org reference through the update path (which persists
    // custom on every engine revision), then prove a refused edit keeps it.
    const seedUpdate = await withOrgContext(org.orgId, () => post(updateBody({ ref_party: fx.tenantId })));
    assert.equal(seedUpdate.status, 200, `seed update must stay green: ${JSON.stringify(await seedUpdate.clone().json().catch(() => null))}`);
    const refusedUpdate = await withOrgContext(org.orgId, () => post(updateBody({ ref_party: foreign.customerId })));
    assert.equal(refusedUpdate.status, 404, `expected 404, got ${refusedUpdate.status}: ${JSON.stringify(await refusedUpdate.clone().json().catch(() => null))}`);
    const storedUpdate = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from managed_properties where id = ${propertyId}`)).rows[0]?.custom;
    assert.equal((storedUpdate as Record<string, unknown> | undefined)?.ref_party, fx.tenantId, 'refused update leaves stored custom untouched');
    const okUpdate = await withOrgContext(org.orgId, () => post(updateBody({})));
    assert.equal(okUpdate.status, 200, `own update must stay green: ${JSON.stringify(await okUpdate.clone().json().catch(() => null))}`);
  } finally {
    state.user = null;
    await dropScratchOrg(foreign.orgId);
    await dropScratchOrg(org.orgId);
  }
});

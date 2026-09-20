import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

/**
 * Property units fence rentableArea to 4dp shape but never bound its
 * magnitude, so a pasted 20-digit area sails through and dies in Postgres as
 * a raw numeric overflow — surfacing the generic 500 instead of failing
 * closed with a named error and nothing written.
 * property_units.rentable_area is numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + '/').href;
const engineRoot = new URL('../../../../engine/', import.meta.url).href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __pmUnitBoundState: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  // Bare @openbooks/engine/* resolves cross-checkout to main; pin the worktree copy.
  if (specifier.startsWith('@openbooks/engine/')) {
    return next(new URL(specifier.slice('@openbooks/engine/'.length), engineRoot).href, context);
  }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__pmUnitBoundState.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { POST } = await import('./route.ts');
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await createScratchUser(org.orgId, 'Property clerk', 'property_clerk');
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.create"]'::jsonb where org_id=${org.orgId} and key='property_clerk'`));
  await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`));
  const propertyId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into managed_properties (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency, rent_income_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-BOUND', 'Bound property', 'commercial', 'active', 'CAD', ${org.accounts.revenue})`));
  state.user = { id: actorId, orgId: org.orgId, name: 'Property clerk', email: 'clerk@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actorId };
  return { org, propertyId };
}

const post = (orgId: string, body: unknown) =>
  withOrgContext(orgId, () => POST(new Request('http://pm.test/api/property-management', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })));

async function unitCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from property_units where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test('unit creation refuses a rentable area wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, propertyId } = await fixture();
  try {
    const response = await post(org.orgId, { action: 'createUnit', propertyId, code: 'U-1', rentableArea: '99999999999999999999.99' });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.notEqual(response.status, 500, `expected a named error, got 500: ${JSON.stringify(json)}`);
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await unitCount(org.orgId), 0);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('unit creation still files an ordinary area', { skip: !DB }, async () => {
  const { org, propertyId } = await fixture();
  try {
    const response = await post(org.orgId, { action: 'createUnit', propertyId, code: 'U-1', rentableArea: '120.5' });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await unitCount(org.orgId), 1);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

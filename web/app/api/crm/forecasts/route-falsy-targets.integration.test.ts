import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url';
import type { SessionUser } from '../../../../lib/auth';

// C2: falsy owner/team targets (false, 0, "") used to skip the format check,
// sail through the forecast as unscoped, then die in Postgres on the uuid
// columns as a generic 500. Each target must now be a UUID or an explicit
// null, refused by name with nothing written. Real route, real database;
// only identity, i18n and module resolution are scripted.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __falsyTargetSession: session });
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__falsyTargetSession.user}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm/crm.ts');
const { POST } = await import('./route');
const { NextRequest } = await import('next/server');

const DB = !!process.env.OPENBOOKS_DB_URL;
const period = { periodStart: '2026-07-01', periodEnd: '2026-07-31' };
const request = (body: Record<string, unknown>) => new NextRequest('http://audit.local', { method: 'POST', body: JSON.stringify({ ...period, ...body }) });
async function snapshotCount(orgId: string) {
  return (await db.execute(sql`select id from crm_forecast_snapshots where org_id=${orgId}`)).rows.length;
}
async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Forecast reviewer', 'reviewer'));
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
  });
  session.user = { id: actor, orgId: org.orgId, name: 'Reviewer', email: 'reviewer@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  await withOrgContext(org.orgId, () => ensureCrmDefaults(org.orgId, actor));
  return { org, actor };
}

for (const falsy of [false, 0, '']) {
  test(`a falsy owner target (${JSON.stringify(falsy)}) is a named 422 with nothing written`, { skip: !DB }, async () => {
    const { org } = await fixture();
    try {
      const response = await POST(request({ ownerUserId: falsy }));
      assert.equal(response.status, 422);
      assert.equal(await response.json().then((b) => b.error), 'forecasts.invalidOwnerTarget');
      assert.equal(await snapshotCount(org.orgId), 0);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
  test(`a falsy team target (${JSON.stringify(falsy)}) is a named 422 with nothing written`, { skip: !DB }, async () => {
    const { org } = await fixture();
    try {
      const response = await POST(request({ ownerUserId: null, salesTeamId: falsy }));
      assert.equal(response.status, 422);
      assert.equal(await response.json().then((b) => b.error), 'forecasts.invalidTeamTarget');
      assert.equal(await snapshotCount(org.orgId), 0);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}

test('explicit nulls still target the whole organization', { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await POST(request({ ownerUserId: null }));
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(await snapshotCount(org.orgId), 1);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

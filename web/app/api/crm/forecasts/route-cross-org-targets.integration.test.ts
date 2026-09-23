import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url';
import type { SessionUser } from '../../../../lib/auth';

// C3: snapshot targets were UUID-syntax-checked only, and the snapshot FKs
// are single-column, so tenant B's user or team id was stored in tenant A's
// snapshot (201). Targets are now looked up org-scoped inside the write and
// refused by name. Real route, real database; only identity, i18n and module
// resolution are scripted.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __crossOrgSession: session });
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__crossOrgSession.user}' };
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
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  const actorA = await withBypassContext(() => createScratchUser(orgA.orgId, 'Reviewer A', 'reviewer'));
  const actorB = await withBypassContext(() => createScratchUser(orgB.orgId, 'Reviewer B', 'reviewer'));
  await withBypassContext(async () => {
    for (const org of [orgA, orgB]) {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
    }
  });
  session.user = { id: actorA, orgId: orgA.orgId, name: 'Reviewer A', email: 'a@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgA.orgId, homeOrgId: orgA.orgId, homeUserId: actorA };
  await withOrgContext(orgA.orgId, () => ensureCrmDefaults(orgA.orgId, actorA));
  await withOrgContext(orgB.orgId, () => ensureCrmDefaults(orgB.orgId, actorB));
  const teamB = (await db.execute<{ id: string }>(sql`select id from crm_sales_teams where org_id=${orgB.orgId} order by name limit 1`)).rows[0]?.id
    ?? (await db.execute<{ id: string }>(sql`insert into crm_sales_teams (org_id, key, name, created_by, updated_by) values (${orgB.orgId}, 'team-b', 'Team B', ${actorB}, ${actorB}) returning id`)).rows[0]!.id;
  return { orgA, orgB, actorB, teamB };
}

test("another org's user cannot be snapshotted into this org", { skip: !DB }, async () => {
  const { orgA, orgB, actorB } = await fixture();
  try {
    const response = await POST(request({ ownerUserId: actorB }));
    assert.equal(response.status, 422);
    assert.equal(await response.json().then((b) => b.error), 'forecasts.ownerOutsideOrganization');
    assert.equal(await snapshotCount(orgA.orgId), 0);
    assert.equal(await snapshotCount(orgB.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("another org's team cannot be snapshotted into this org", { skip: !DB }, async () => {
  const { orgA, orgB, teamB } = await fixture();
  try {
    const response = await POST(request({ ownerUserId: null, salesTeamId: teamB }));
    assert.equal(response.status, 422);
    assert.equal(await response.json().then((b) => b.error), 'forecasts.teamOutsideOrganization');
    assert.equal(await snapshotCount(orgA.orgId), 0);
    assert.equal(await snapshotCount(orgB.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("this org's own user still snapshots", { skip: !DB }, async () => {
  const { orgA, orgB } = await fixture();
  try {
    const response = await POST(request({}));
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(await snapshotCount(orgA.orgId), 1);
  } finally {
    session.user = null;
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

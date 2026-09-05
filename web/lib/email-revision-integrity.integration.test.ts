import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __emailRevisionSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__emailRevisionSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { readOrgEmailConfigView, saveOrgEmailConfig, OrgEmailConfigConflictError } = await import("@openbooks/engine/src/email-config.ts");
const { PUT } = await import("../app/api/admin/email/route");
for (const operation of ['engine', 'http']) {
  test(`email ${operation} refuses a one-microsecond stale form`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, 'Email administrator', 'reviewer');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user = { id:actor, orgId:org.orgId, name:'Email administrator', email:'email@scratch.test', roles:[], isSuperAdmin:false, envKind:'production', productionOrgId:org.orgId, homeOrgId:org.orgId, homeUserId:actor };
      await db.execute(sql`update orgs set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${org.orgId}`);
      const view = await readOrgEmailConfigView(org.orgId);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{email}','{"enabled":false,"fromName":"Concurrent administrator"}'::jsonb), updated_at=updated_at+interval '1 microsecond' where id=${org.orgId}`);
      if (operation === 'engine') {
        await assert.rejects(saveOrgEmailConfig(org.orgId, {enabled:false,fromName:'Stale form'}, {kind:'user',userId:actor}, {expectedUpdatedAt:view.updatedAt!}), error=>error instanceof OrgEmailConfigConflictError);
      } else {
        const response = await withOrgContext(org.orgId,()=>PUT(new Request('http://audit.local/api/admin/email',{method:'PUT',body:JSON.stringify({enabled:false,fromName:'Stale form',expectedUpdatedAt:view.updatedAt!})})));
        assert.equal(response.status,409,JSON.stringify(await response.json()));
      }
      assert.equal((await readOrgEmailConfigView(org.orgId)).fromName,'Concurrent administrator');
    } finally { session.user=null; await dropScratchOrg(org.orgId); }
  });
}

test('email saves in one transaction advance the revision and reject a replay', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const { withOrg } = await import("@openbooks/engine/src/db.ts");
    await withOrg(org.orgId, async () => {
      const actor = {kind:'system' as const,reason:'Revision regression'};
      const first = await saveOrgEmailConfig(org.orgId,{enabled:false,fromName:'First'},actor);
      const second = await saveOrgEmailConfig(org.orgId,{fromName:'Second'},actor,{expectedUpdatedAt:first.updatedAt!});
      assert.notEqual(second.updatedAt,first.updatedAt,'every accepted material save advances its token');
      await assert.rejects(saveOrgEmailConfig(org.orgId,{fromName:'Stale'},actor,{expectedUpdatedAt:first.updatedAt!}),OrgEmailConfigConflictError);
    });
  } finally { await dropScratchOrg(org.orgId); }
});

for (const revision of [undefined, null, "", "2026-01-01T00:00:00.123Z", "garbage"]) {
  test(`email HTTP refuses an absent or malformed revision: ${String(revision)}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Email administrator", "reviewer");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user = { id: actor, orgId: org.orgId, name: "Email administrator", email: "email@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const before = await readOrgEmailConfigView(org.orgId);
      const response = await withOrgContext(org.orgId, () => PUT(new Request("http://audit.local/api/admin/email", {
        method: "PUT", body: JSON.stringify({ enabled: false, fromName: "Unreviewed", expectedUpdatedAt: revision }),
      })));
      assert.equal(response.status, 409);
      assert.deepEqual(await readOrgEmailConfigView(org.orgId), before);
    } finally { session.user = null; await dropScratchOrg(org.orgId); }
  });
}

test("email HTTP returns the exact committed revision for a valid save and retry", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Email administrator", "reviewer");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
    session.user = { id: actor, orgId: org.orgId, name: "Email administrator", email: "email@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    let previous = await readOrgEmailConfigView(org.orgId);
    for (const fromName of ["First accepted edit", "Second accepted edit"]) {
      const response = await withOrgContext(org.orgId, () => PUT(new Request("http://audit.local/api/admin/email", {
        method: "PUT", body: JSON.stringify({ enabled: false, fromName, expectedUpdatedAt: previous.updatedAt }),
      })));
      const saved = await response.json();
      assert.equal(response.status, 200, JSON.stringify(saved));
      assert.match(saved.updatedAt, /\.\d{6}Z$/);
      assert.notEqual(saved.updatedAt, previous.updatedAt);
      assert.deepEqual(saved, await readOrgEmailConfigView(org.orgId));
      assert.equal(saved.fromName, fromName);
      previous = saved;
    }
  } finally { session.user = null; await dropScratchOrg(org.orgId); }
});

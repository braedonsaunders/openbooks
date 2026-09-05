import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __customFieldCreation: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__customFieldCreation.user}' };
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { POST } = await import('../app/api/admin/custom-fields/route');

const { installApp } = await import('./apps/store');

const request = (body: unknown) => new Request('http://audit.local/api/admin/custom-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
for (const mode of ['API requests', 'app installs', 'API and app installs', 'reversed app bundles']) {
  test(`custom-field creation serializes competing ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Creation reviewer', email: 'creation@scratch.test', roles: [], isSuperAdmin: false };
      await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      const field = { targetTable: 'parties', key: 'concurrent_review', label: 'Concurrent review', fieldType: 'text' };
      const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
        const app = mode === 'app installs' || mode === 'reversed app bundles' || (mode === 'API and app installs' && index % 2 === 0);
        if (!app) {
          const response = await withOrgContext(org.orgId, () => POST(request(field)));
          return { app, status: response.status, result: await response.json() };
        }
        try {
          const result = await withOrgContext(org.orgId, () => installApp(org.orgId, actor, {
            manifest: { key: `race-review-${index}`, name: 'Creation review', version: '1.0.0', permissions: [], frontend: { entry: 'frontend/index.html' } },
            files: [{ path: 'frontend/index.html', content: '<p>Review</p>' }, ...(mode === 'reversed app bundles' ? (index % 2 ? [field, { ...field, key: 'another_review' }] : [{ ...field, key: 'another_review' }, field]) : [field]).map((definition, i) => ({ path: `objects/field-${i}.json`, content: JSON.stringify({ type: 'custom_field', ...definition }) }))],
          }));
          return { app, status: 200, result };
        } catch (error) {
          return { app, status: (error as { status?: number }).status, result: String(error) };
        }
      }));
      const winners = outcomes.filter(outcome => outcome.status === 200);
      assert.equal(winners.length, 1, JSON.stringify(outcomes));
      assert.ok(outcomes.every(outcome => outcome.status === 200 || outcome.status === 409), JSON.stringify(outcomes));
      const counts = (await db.execute<{ definitions: number; apps: number; versions: number }>(sql`select
        (select count(*)::int from custom_field_defs where org_id=${org.orgId} and key=${field.key}) as definitions,
        (select count(*)::int from apps where org_id=${org.orgId}) as apps,
        (select count(*)::int from app_versions where org_id=${org.orgId}) as versions`)).rows[0]!;
      assert.deepEqual(counts, { definitions: 1, apps: winners[0]!.app ? 1 : 0, versions: winners[0]!.app ? 1 : 0 }, 'losing installs roll back every app/version write');
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}

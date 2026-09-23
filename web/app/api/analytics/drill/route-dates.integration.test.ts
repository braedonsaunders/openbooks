import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../lib/test-module-hooks';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from '../../../../lib/auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __analyticsDrillDates: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsDrillDates.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

test('analytics drill validates calendar dates before querying', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Drill reviewer', 'drill_reviewer'));
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='drill_reviewer'`));
    state.user = { id: actor, orgId: org.orgId, name: 'Drill reviewer', email: 'drill@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const account = randomUUID();
    await withOrgContext(org.orgId, async () => {
      for (const query of [
        `account=${account}&from=not-a-date&to=2026-07-31`,
        `account=${account}&from=2026-07-31&to=2026-07-01`,
        `party=${account}&from=2026-07-01&to=July 31`,
      ]) {
        const response = await GET(new Request(`http://dates.local/api/analytics/drill?${query}`));
        assert.equal(response.status, 400, `must refuse ${query}`);
        const body = await response.json() as { error: string };
        assert.ok(body.error.includes('from/to'), `refusal must name the dates, got: ${body.error}`);
      }
      const ok = await GET(new Request(`http://dates.local/api/analytics/drill?account=${account}&from=2026-07-01&to=2026-07-31`));
      assert.equal(ok.status, 200);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

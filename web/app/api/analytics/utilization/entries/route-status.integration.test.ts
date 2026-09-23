import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../../lib/test-module-hooks';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from '../../../../../lib/auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __utilEntriesStatus: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilEntriesStatus.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

test('utilization entries drill lists approved time only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Time reviewer', 'time_reviewer'));
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='time_reviewer'`));
    state.user = { id: actor, orgId: org.orgId, name: 'Time reviewer', email: 'time@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

    const employee = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Status Worker',${org.subsidiaryId})`));
    for (const [status, hours] of [['approved', '8'], ['draft', '8'], ['submitted', '4'], ['rejected', '2']] as const) {
      await withBypassContext(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${org.date},${hours},null,${org.items.service},true,'10',${status})`));
    }

    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://status.local/api/analytics/utilization/entries?employee=${employee}&from=2026-07-01&to=2026-07-31`),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { entries: Array<{ hours: number }> };
      assert.equal(body.entries.length, 1, 'draft/submitted/rejected hours must not appear in the drill');
      assert.equal(body.entries[0]!.hours, 8);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

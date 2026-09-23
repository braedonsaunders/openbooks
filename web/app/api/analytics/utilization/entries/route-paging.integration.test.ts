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
Object.assign(globalThis, { __utilEntriesPaging: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilEntriesPaging.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

interface PagingBody {
  entries: Array<{ id: string; hours: number }>;
  currency: string;
  total: { count: number; hours: string; billableHours: string };
  groups: {
    byPeer: Array<{ label: string; hours: string; billableHours: string }>;
    byCustomer: Array<{ label: string; hours: string; billableHours: string }>;
  };
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

async function get(query: string): Promise<{ status: number; body: PagingBody }> {
  const response = await GET(new Request(`http://paging.local/api/analytics/utilization/entries?${query}`));
  return { status: response.status, body: await response.json() as PagingBody };
}

test('utilization entries drill pages with full-population aggregates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Time reviewer', 'time_reviewer'));
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='time_reviewer'`));
    state.user = { id: actor, orgId: org.orgId, name: 'Time reviewer', email: 'time@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

    const employee = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Paging Worker',${org.subsidiaryId})`));
    // 505 approved one-hour entries, even series billable (252 of 505).
    await withBypassContext(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,status)
      select ${org.orgId},${employee},${org.date},'1',null,${org.items.service},(g % 2 = 0),'1','approved' from generate_series(1,505) g`));

    await withOrgContext(org.orgId, async () => {
      const base = `employee=${employee}&from=2026-07-01&to=2026-07-31`;
      const first = await get(base);
      assert.equal(first.status, 200);
      assert.equal(first.body.entries.length, 500, 'first page holds the default limit');
      assert.equal(first.body.page.hasMore, true);
      assert.ok(first.body.page.nextCursor, 'a further page is advertised');
      // Headline reads the whole population, not the visible 500.
      assert.equal(first.body.total.count, 505);
      assert.equal(first.body.total.hours, '505.0000');
      assert.equal(first.body.total.billableHours, '252.0000');
      const pageHours = first.body.entries.reduce((sum, e) => sum + e.hours, 0);
      assert.ok(Number(first.body.total.hours) > pageHours, 'server total must exceed the capped page sum');
      // Shares read the whole population too.
      assert.equal(first.body.groups.byPeer.length, 1);
      assert.equal(first.body.groups.byPeer[0]!.hours, '505.0000');
      assert.equal(first.body.groups.byPeer[0]!.billableHours, '252.0000');

      const second = await get(`${base}&cursor=${encodeURIComponent(first.body.page.nextCursor!)}`);
      assert.equal(second.status, 200);
      assert.equal(second.body.entries.length, 5);
      assert.equal(second.body.page.hasMore, false);
      assert.equal(second.body.page.nextCursor, null);
      assert.equal(second.body.total.count, 505);
      const ids = new Set([...first.body.entries, ...second.body.entries].map((e) => e.id));
      assert.equal(ids.size, 505, 'pages tile the population without overlap or gaps');

      const small = await get(`${base}&limit=100`);
      assert.equal(small.status, 200);
      assert.equal(small.body.entries.length, 100);
      assert.equal(small.body.page.limit, 100);
      assert.equal(small.body.page.hasMore, true);

      for (const bad of [`${base}&limit=0`, `${base}&limit=501`, `${base}&limit=many`, `${base}&cursor=bogus`]) {
        const denied = await GET(new Request(`http://paging.local/api/analytics/utilization/entries?${bad}`));
        assert.equal(denied.status, 400, `must refuse ${bad}`);
      }
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

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
Object.assign(globalThis, { __utilEntriesScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilEntriesScope.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

const FROM = '2026-07-01';
const TO = '2026-07-31';

interface DrillBody {
  entries: Array<{ employeeName: string; hours: number }>;
}

async function drill(employee: string): Promise<{ status: number; body: DrillBody }> {
  const response = await GET(
    new Request(`http://scope.local/api/analytics/utilization/entries?employee=${employee}&from=${FROM}&to=${TO}`),
  );
  return { status: response.status, body: await response.json() };
}

for (const mode of ['all', 'restricted', 'empty'] as const) {
  test(`utilization entries drill subsidiary scope: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Time reviewer', 'time_reviewer'));
      const restriction = mode === 'all'
        ? { mode: 'all' }
        : { mode: 'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] };
      await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='time_reviewer'`));
      state.user = { id: actor, orgId: org.orgId, name: 'Time reviewer', email: 'time@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

      const hidden = randomUUID();
      const visibleProject = randomUUID();
      const hiddenProject = randomUUID();
      await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`));
      for (const [project, sub] of [[visibleProject, org.subsidiaryId], [hiddenProject, hidden]] as const) {
        await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${sub},${project},'Time project',${org.customerId},'active',true)`));
      }
      // [employee subsidiary, project, hours, name] — the dashboard admits an
      // entry when coalesce(project, employee) subsidiary is visible.
      const cases = [
        [org.subsidiaryId, visibleProject, '1', 'Visible project worker'],
        [hidden, hiddenProject, '9', 'PRIVATE-UTIL-DRILL-EVIDENCE'],
        [org.subsidiaryId, hiddenProject, '8', 'PRIVATE-UTIL-DRILL-EVIDENCE'],
        [hidden, visibleProject, '2', 'Visible cross-company worker'],
        [org.subsidiaryId, null, '3', 'Visible internal worker'],
        [hidden, null, '7', 'PRIVATE-UTIL-DRILL-EVIDENCE'],
      ] as const;
      const employeeIds: string[] = [];
      for (const [sub, project, hours, name] of cases) {
        const employee = randomUUID();
        employeeIds.push(employee);
        await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person',${name},${sub})`));
        await withBypassContext(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${org.date},${hours},${project},${org.items.service},${project !== null},10,'approved')`));
      }

      await withOrgContext(org.orgId, async () => {
        // Visible employees: full rows. Hidden employees: no rows — and never
        // the private name, memo-shaped evidence or hours.
        const visibleIdx = mode === 'all' ? [0, 1, 2, 3, 4, 5] : mode === 'empty' ? [] : [0, 3, 4];
        for (let i = 0; i < cases.length; i++) {
          const { status, body } = await drill(employeeIds[i]!);
          assert.equal(status, 200);
          if (visibleIdx.includes(i)) {
            assert.equal(body.entries.length, 1, `employee ${i} must stay visible in ${mode} mode`);
            assert.equal(body.entries[0]!.employeeName, cases[i]![3]);
          } else {
            assert.equal(body.entries.length, 0, `employee ${i} must be hidden in ${mode} mode`);
          }
        }
        // Item drill over the shared service item: restricted callers see only
        // visible-subsidiary rows.
        const itemRes = await GET(
          new Request(`http://scope.local/api/analytics/utilization/entries?item=${org.items.service}&from=${FROM}&to=${TO}`),
        );
        assert.equal(itemRes.status, 200);
        const itemBody = await itemRes.json() as { entries: Array<{ employeeName: string; hours: number }> };
        const payload = JSON.stringify(itemBody);
        if (mode === 'all') {
          assert.equal(itemBody.entries.length, 6);
          assert.ok(payload.includes('PRIVATE-UTIL-DRILL-EVIDENCE'));
        } else if (mode === 'empty') {
          assert.equal(itemBody.entries.length, 0);
          assert.ok(!payload.includes('PRIVATE-UTIL-DRILL-EVIDENCE'));
        } else {
          assert.equal(itemBody.entries.length, 3);
          assert.ok(!payload.includes('PRIVATE-UTIL-DRILL-EVIDENCE'));
          assert.equal(itemBody.entries.reduce((sum, e) => sum + e.hours, 0), 6);
        }
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}

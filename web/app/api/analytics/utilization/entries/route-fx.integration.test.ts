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
Object.assign(globalThis, { __utilEntriesFx: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilEntriesFx.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

interface FxBody {
  currency: string;
  entries: Array<{ cost: string }>;
}

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Time reviewer', 'time_reviewer'));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='time_reviewer'`));
  state.user = { id: actor, orgId: org.orgId, name: 'Time reviewer', email: 'time@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  await withBypassContext(() => db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2),('EUR','Euro',2) on conflict (code) do nothing`));
  await withBypassContext(() => db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${org.orgId},'USD','CAD','2026-07-14','spot',1.35,'manual')`));
  return { org, actor };
}

test('utilization entries drill translates labour cost to presentation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    const employee = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Fx Worker',${org.subsidiaryId})`));
    // Native CAD 8 x 2h stays 16; USD 10 x 3h translates at the worked-date
    // spot (1.35) to 40.50 CAD — never a 1:1 mix.
    await withBypassContext(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,cost_rate_currency,status) values
      (${org.orgId},${employee},${org.date},2,null,${org.items.service},false,'8','CAD','approved'),
      (${org.orgId},${employee},${org.date},3,null,${org.items.service},false,'10','USD','approved')`));
    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://fx.local/api/analytics/utilization/entries?employee=${employee}&from=2026-07-01&to=2026-07-31`),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as FxBody;
      assert.equal(body.currency, 'CAD');
      const costs = body.entries.map((e) => e.cost).sort();
      assert.deepEqual(costs, ['16.0000', '40.5000']);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('utilization entries drill refuses by name on missing FX coverage', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    const employee = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Uncovered Worker',${org.subsidiaryId})`));
    await withBypassContext(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,cost_rate_currency,status) values
      (${org.orgId},${employee},${org.date},2,null,${org.items.service},false,'8','EUR','approved')`));
    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://fx.local/api/analytics/utilization/entries?employee=${employee}&from=2026-07-01&to=2026-07-31`),
      );
      assert.equal(response.status, 422);
      const body = await response.json() as { error: string; message: string };
      assert.equal(body.error, 'missing exchange rate');
      assert.ok(body.message.includes('EUR') && body.message.includes('CAD'), `refusal must name the pair, got: ${body.message}`);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { resolveAppModule } from './test-module-hooks';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from './auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __utilExactness: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilExactness.user}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { utilizationData } = await import('./analytics/utilization-data');

/**
 * Utilization money must stay exact until rendering. Three 0.1 legs — kept
 * as separate employee rows so they accumulate in JS, not in Postgres — sum
 * to 0.30000000000000004 in float arithmetic. That single binary-dust ulp
 * both corrupts the reported cost and fires a cost-spike alert whose
 * threshold sits at exactly the true delta.
 */
test('utilization accumulates cost exactly and decides alerts on exact decimals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{analytics,utilization}',
        '{"targetBillablePct":70,"costSpikeThreshold":0.3,"minHours":0}') where id = ${org.orgId}`);
      for (let n = 0; n < 3; n++) {
        const employee = randomUUID();
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
          values (${employee}, ${org.orgId}, 'person', ${`Exact Worker ${n}`}, ${org.subsidiaryId})`);
        await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, cost_rate_currency, status)
          values (${org.orgId}, ${employee}, ${org.date}, '1', null, ${org.items.service}, false, '0.1000', 'CAD', 'approved')`);
      }
    });
    await withOrgContext(org.orgId, async () => {
      const data = await utilizationData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null);
      assert.equal(data.company.range.nonBillableCost, 0.3, 'fractional legs must sum exactly');
      assert.equal(data.employees.length, 3);
      assert.equal(data.company.deltas.costDelta, 0.3);
      // 0% billed is below the 70% target (warning), but the 0.3 delta sits
      // exactly AT the spike threshold — an exact comparison raises no
      // danger alert, while float dust (0.30000000000000004) would.
      assert.ok(data.company.alerts.some((a) => a.type === 'warning'), 'below-target warning still fires');
      assert.ok(data.company.alerts.every((a) => a.type !== 'danger'), 'no cost-spike alert at exact threshold equality');
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

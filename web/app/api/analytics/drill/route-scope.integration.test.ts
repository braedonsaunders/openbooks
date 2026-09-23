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
Object.assign(globalThis, { __analyticsDrillScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsDrillScope.user}' };
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

async function setup(mode: 'all' | 'restricted') {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Drill reviewer', 'drill_reviewer'));
  const restriction = mode === 'all' ? { mode: 'all' } : { mode: 'list', subsidiaryIds: [org.subsidiaryId] };
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='drill_reviewer'`));
  state.user = { id: actor, orgId: org.orgId, name: 'Drill reviewer', email: 'drill@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

  const hidden = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`));
  // One vendor per subsidiary; one posted spend bill + fully posted GL leg each.
  const visibleVendor = randomUUID();
  const hiddenVendor = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values
    (${visibleVendor},${org.orgId},'vendor','Visible Vendor',${org.subsidiaryId}),
    (${hiddenVendor},${org.orgId},'vendor','PRIVATE-DRILL-VENDOR',${hidden})`));
  for (const [vendor, sub, amount, number] of [
    [visibleVendor, org.subsidiaryId, '100', 'VISIBLE-BILL'],
    [hiddenVendor, hidden, '200', 'PRIVATE-BILL'],
  ] as const) {
    const docId = randomUUID();
    const entryId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
      values (${docId},${org.orgId},'vendor_bill',${number},${org.date},${org.date},${vendor},${sub},'CAD',${amount},0,${amount})`));
    await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
      values (${entryId},${org.orgId},${org.bookId},${sub},${docId},${org.date},${org.periodId},'draft','purchasing',${docId})`));
    await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
      values (${randomUUID()},${org.orgId},${entryId},1,${org.accounts.cogs},${sub},${vendor},false,${amount},'CAD',${amount},1,${org.date}),
             (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.ap},${sub},${vendor},true,-${amount}::numeric,'CAD',-${amount}::numeric,1,${org.date})`));
    await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${entryId}`));
    await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${entryId},posting_period_id=${org.periodId} where id=${docId}`));
  }
  return { org, visibleVendor, hiddenVendor };
}

test('analytics account drill applies the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const mode of ['all', 'restricted'] as const) {
    const { org } = await setup(mode);
    try {
      await withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(`http://drillscope.local/api/analytics/drill?account=${org.accounts.cogs}&from=${FROM}&to=${TO}`),
        );
        assert.equal(response.status, 200);
        const body = await response.json() as {
          count: number; total: string;
          entries: Array<{ label: string; memo: string }>;
          breakdown: Array<{ name: string }>;
          monthly: Array<{ amount: string }>;
        };
        const payload = JSON.stringify(body);
        if (mode === 'all') {
          assert.equal(body.count, 2);
          assert.ok(payload.includes('PRIVATE-DRILL-VENDOR'));
        } else {
          // Only the visible subsidiary's leg: no hidden names, memos,
          // amounts or totals leak through detail OR summaries.
          assert.equal(body.count, 1);
          assert.ok(!payload.includes('PRIVATE-DRILL-VENDOR'));
          assert.ok(!payload.includes('PRIVATE-BILL'));
          assert.ok(body.entries.every((e) => e.label.includes('Visible Vendor')));
          assert.ok(body.breakdown.every((b) => !b.name.includes('PRIVATE')));
        }
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  }
});

test('analytics party drill applies the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const mode of ['all', 'restricted'] as const) {
    const { org, hiddenVendor } = await setup(mode);
    try {
      await withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(`http://drillscope.local/api/analytics/drill?party=${hiddenVendor}&from=${FROM}&to=${TO}`),
        );
        assert.equal(response.status, 200);
        const body = await response.json() as { count: number; total: string; entries: unknown[] };
        if (mode === 'all') {
          assert.equal(body.count, 1);
        } else {
          assert.equal(body.count, 0);
          assert.deepEqual(body.entries, []);
        }
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  }
});

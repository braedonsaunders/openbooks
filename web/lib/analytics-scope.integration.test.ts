import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from './auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
const period = { from: '2026-07-01', to: '2026-07-31', label: 'Scope review' };
Object.assign(globalThis, { __analyticsScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsScope.user}' };
  if (specifier.endsWith('/lib/periods') && /analytics\/(customer-intelligence|vendor-performance|spend-velocity)\/page.tsx$/.test(context.parentURL ?? '')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolvePeriod(){return '+JSON.stringify(period)+'}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { getAuthz } = await import('./authz');
const { customerData, customerProfitability } = await import('./analytics/customer-data');
const { vendorData } = await import('./analytics/vendor-data');
const { spendVelocityData } = await import('./analytics/spend-velocity-data');
const { default: CustomerPage } = await import('../app/(app)/analytics/customer-intelligence/page');
const { default: VendorPage } = await import('../app/(app)/analytics/vendor-performance/page');
const { default: SpendPage } = await import('../app/(app)/analytics/spend-velocity/page');
const { executeAssistantTool } = await import('./assistant/registry');
type Summary = { kpis?: { totalRevenue: number }; totals?: { spend: number }; summary?: { totalSpend: number }; commitmentCliff?: { summary: { totalPO: number; totalSO: number } }; expenseAnalysis?: { topSpenders: { totalSpend: number }[] | { items: { totalSpend: number }[] } } };

for (const surface of ['customer', 'vendor', 'spend'] as const) {
  for (const boundary of ['service', 'page', 'assistant'] as const) {
    for (const mode of ['all', 'restricted', 'empty'] as const) {
      test(`Analytics subsidiary access ${surface} ${boundary}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
        const org = await createScratchOrg();
        try {
          const actor = await createScratchUser(org.orgId, 'Analytics reviewer', 'analytics_reviewer');
          const restriction = mode === 'all' ? { mode: 'all' } : { mode: 'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] };
          await db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='analytics_reviewer'`);
          state.user = { id: actor, orgId: org.orgId, name: 'Analytics reviewer', email: 'analytics@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
          const hidden = randomUUID();
          await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`);
          for (const [sub, amount, name] of [[org.subsidiaryId, '100', 'Visible'], [hidden, '999', 'PRIVATE-ANALYTICS-EVIDENCE']]) {
            const party = randomUUID(), project = randomUUID();
            await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${party},${org.orgId},'organization',${name},${sub})`);
            await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${sub},${project},${name},${party},'active',true)`);
            for (const kind of ['vendor_bill', 'customer_invoice', 'expense_report'] as const) {
              const entry = randomUUID(), doc = randomUUID();
              const total = kind === 'expense_report' ? sub === org.subsidiaryId ? '2' : '20' : amount;
              const signed = kind === 'customer_invoice' ? '-'+total : total;
              const account = kind === 'customer_invoice' ? org.accounts.revenue : org.accounts.cogs;
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
                values (${doc},${org.orgId},${kind},${doc},${org.date},${org.date},${org.date},${party},${sub},'CAD',${total},0,${total})`);
              await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
                values (${entry},${org.orgId},${org.bookId},${sub},${entry},${org.date},${org.periodId},'draft','manual',${doc})`);
              await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
                values (${org.orgId},${entry},1,${account},${sub},${project},${party},${signed},'CAD',${signed},1),
                (${org.orgId},${entry},2,${org.accounts.bank},${sub},${project},${party},-${signed}::numeric,'CAD',-${signed}::numeric,1)`);
              await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
              await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${doc}`);
            }
            for (const kind of ['purchase_order','sales_order']) {
              const doc = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
                values (${doc},${org.orgId},${kind},${doc},${org.date},${org.date},${party},${sub},'CAD',${amount},0,${amount})`);
            }
          }
          await withOrgContext(org.orgId, async () => {
            const authz = await getAuthz(); assert.ok(authz);
            let data: Summary;
            let profitability: unknown;
            if (boundary === 'service') {
              data = surface === 'customer' ? await customerData(period, org.orgId, authz.allowedSubsidiaryIds)
                : surface === 'vendor' ? await vendorData(period, org.orgId, authz.allowedSubsidiaryIds)
                : await spendVelocityData(org.orgId, period, authz.allowedSubsidiaryIds);
              if (surface === 'customer') profitability = await customerProfitability(period, org.orgId, authz.allowedSubsidiaryIds);
            } else if (boundary === 'page') {
              const page = surface === 'customer' ? CustomerPage : surface === 'vendor' ? VendorPage : SpendPage;
              const output = await page({ searchParams: Promise.resolve({}) });
              const children = React.Children.toArray((output.props as { children: React.ReactNode }).children);
              const view = children.find(React.isValidElement); assert.ok(view && React.isValidElement(view));
              const props = view.props as { data: Summary; profitability?: unknown };
              data = props.data; profitability = props.profitability;
            } else {
              const tool = surface === 'customer' ? 'analytics_customer_intelligence' : surface === 'vendor' ? 'analytics_vendor_performance' : 'analytics_spend_velocity';
              const result = await executeAssistantTool(authz, tool, { fromDate: period.from, toDate: period.to });
              assert.equal(result.ok, true); assert.ok(result.ok);
              data = result.data as Summary;
              profitability = (result.data as { profitability?: unknown }).profitability;
            }
            const expectedRevenue = mode === 'all' ? 1099 : mode === 'empty' ? 0 : 100;
            const expected = surface === 'customer' ? expectedRevenue : mode === 'all' ? 1121 : mode === 'empty' ? 0 : 102;
            assert.equal(surface === 'customer' ? data.kpis?.totalRevenue : surface === 'vendor' ? data.totals?.spend : data.summary?.totalSpend, expected);
            assert.equal(JSON.stringify(data).includes('PRIVATE-ANALYTICS-EVIDENCE'), mode === 'all');
            if (surface === 'spend') {
              assert.equal(data.commitmentCliff?.summary.totalPO, expectedRevenue);
              assert.equal(data.commitmentCliff?.summary.totalSO, expectedRevenue);
              const spenders = data.expenseAnalysis?.topSpenders;
              assert.ok(spenders);
              assert.equal((Array.isArray(spenders) ? spenders : spenders.items).reduce((total,row) => total + row.totalSpend,0), mode === 'all' ? 22 : mode === 'empty' ? 0 : 2);
            }
            if (surface === 'customer') {
              assert.equal((profitability as { summary: { totalRevenue: number } }).summary.totalRevenue, expectedRevenue);
              assert.equal(JSON.stringify(profitability).includes('PRIVATE-ANALYTICS-EVIDENCE'), mode === 'all');
            }
          });
        } finally { state.user = null; await dropScratchOrg(org.orgId); }
      });
    }
  }
}

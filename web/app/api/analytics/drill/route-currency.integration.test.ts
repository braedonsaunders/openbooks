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
Object.assign(globalThis, { __analyticsDrillCurrency: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsDrillCurrency.user}' };
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
  mode: string;
  currency: string;
  total: string;
  count: number;
  entries: Array<{ docNumber: string; amount: string }>;
  monthly: Array<{ month: string; amount: string }>;
  breakdown: Array<{ name: string; amount: string; count: number }>;
}

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Drill reviewer', 'drill_reviewer'));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='drill_reviewer'`));
  state.user = { id: actor, orgId: org.orgId, name: 'Drill reviewer', email: 'drill@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  await withBypassContext(() => db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2),('EUR','Euro',2) on conflict (code) do nothing`));
  const usSub = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`));
  return { org, usSub };
}

interface ScratchOrg {
  orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string;
  accounts: { ap: string; ar: string; revenue: string };
}

async function postBalancedEntry(org: ScratchOrg, sub: string, date: string, debit: string, credit: string, amount: string, currency: string, docId: string | null, origin: string) {
  const entryId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entryId},${org.orgId},${org.bookId},${sub},${entryId},${date},${org.periodId},'draft',${origin},${docId})`));
  await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${randomUUID()},${org.orgId},${entryId},1,${debit},${sub},false,${amount},${currency},${amount},1,${date}),
           (${randomUUID()},${org.orgId},${entryId},2,${credit},${sub},false,-${amount}::numeric,${currency},-${amount}::numeric,1,${date})`));
  await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${entryId}`));
  return entryId;
}

async function postDoc(org: ScratchOrg, party: string, sub: string, number: string, total: string, currency: string, fx: string) {
  const docId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total,fx_rate)
    values (${docId},${org.orgId},'customer_invoice',${number},${org.date},${org.date},${party},${sub},${currency},${total},0,${total},${fx})`));
  const entryId = await postBalancedEntry(org, sub, org.date, org.accounts.ar, org.accounts.revenue, total, currency, docId, 'sales');
  await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${entryId},posting_period_id=${org.periodId} where id=${docId}`));
  return docId;
}

/**
 * CAD 100 plus USD 100 is CAD 235 at the worked-date spot — never "CAD 200"
 * with a "CAD 100" average.
 */
test('analytics party drill translates mixed currencies to presentation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    await withBypassContext(() => db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD','2026-07-14','spot',1.35,'manual')`));
    const customer = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${customer},${org.orgId},'customer','Currency Customer',${org.subsidiaryId})`));
    await postDoc(org, customer, org.subsidiaryId, 'CAD-INV', '100', 'CAD', '1');
    await postDoc(org, customer, org.subsidiaryId, 'USD-INV', '100', 'USD', '1.35');
    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://drillfx.local/api/analytics/drill?party=${customer}&from=${FROM}&to=${TO}`),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as DrillBody;
      assert.equal(body.currency, 'CAD');
      assert.equal(body.count, 2);
      assert.equal(body.total, '235', 'USD leg translates at its own rate instead of mixing 1:1');
      assert.deepEqual(body.entries.map((e) => e.amount).sort(), ['100', '135']);
      assert.deepEqual(body.monthly, [{ month: '2026-07', amount: '235' }]);
      assert.deepEqual(body.breakdown, [{ name: 'customer_invoice', amount: '235', count: 2 }]);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('analytics account drill translates multi-functional legs', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, usSub } = await setup();
  try {
    await withBypassContext(() => db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD','2026-07-14','spot',1.35,'manual')`));
    // CAD 100 in Main Co plus a USD 100 leg in US Co.
    await postBalancedEntry(org, org.subsidiaryId, org.date, org.accounts.cogs, org.accounts.ap, '100', 'CAD', null, 'manual');
    await postBalancedEntry(org, usSub, org.date, org.accounts.cogs, org.accounts.ap, '100', 'USD', null, 'manual');
    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://drillfx.local/api/analytics/drill?account=${org.accounts.cogs}&from=${FROM}&to=${TO}`),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as DrillBody;
      assert.equal(body.currency, 'CAD');
      assert.equal(body.count, 2);
      assert.equal(body.total, '235');
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('analytics party drill refuses by name on missing FX coverage', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, usSub } = await setup();
  try {
    // A USD-subsidiary invoice with no USD→CAD coverage: the second
    // translation leg names the missing pair instead of mixing 1:1.
    const customer = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${customer},${org.orgId},'customer','Uncovered Customer',${usSub})`));
    await postDoc(org, customer, usSub, 'USD-INV', '100', 'USD', '1.35');
    await withOrgContext(org.orgId, async () => {
      const response = await GET(
        new Request(`http://drillfx.local/api/analytics/drill?party=${customer}&from=${FROM}&to=${TO}`),
      );
      assert.equal(response.status, 422);
      const body = await response.json() as { error: string; message: string };
      assert.equal(body.error, 'missing exchange rate');
      assert.ok(body.message.includes('USD') && body.message.includes('CAD'), `refusal must name the pair, got: ${body.message}`);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

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
Object.assign(globalThis, { __entityRecents: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__entityRecents.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

interface RecentsBody {
  currency: string;
  recentPayments: Array<{ docId: string; docKind: string; entryId: string; docNumber: string; date: string; amount: string }>;
}

interface PayOrg {
  orgId: string; bookId: string; subsidiaryId: string; periodId: string;
  accounts: { bank: string; ar: string };
}

async function postPaymentLines(orgId: string, entryId: string, sub: string, party: string, date: string, bank: string, ar: string, total: string, currency: string) {
  await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${randomUUID()},${orgId},${entryId},1,${bank},${sub},${party},false,${total},${currency},${total},1,${date}),
           (${randomUUID()},${orgId},${entryId},2,${ar},${sub},${party},false,-${total}::numeric,${currency},-${total}::numeric,1,${date})`));
}

async function postPaymentDoc(org: PayOrg, party: string, sub: string, date: string, number: string, total: string, currency: string, fx: string, status: 'posted' | 'draft') {
  const docId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total,fx_rate)
    values (${docId},${org.orgId},'customer_payment',${number},${date},${date},${party},${sub},${currency},${total},0,${total},${fx})`));
  const entryId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entryId},${org.orgId},${org.bookId},${sub},${entryId},${date},${org.periodId},'draft','cash',${docId})`));
  if (status === 'posted') {
    await postPaymentLines(org.orgId, entryId, sub, party, date, org.accounts.bank, org.accounts.ar, total, currency);
    await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${entryId}`));
    await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${entryId},posting_period_id=${org.periodId} where id=${docId}`));
  }
  // A draft payment keeps its draft posting: listed by neither the document
  // nor the entry population.
  return { docId, entryId };
}

/**
 * Payment history lists posted sources once: a draft payment never appears,
 * and a payment posted in a parallel book is not a second payment.
 */
test('entity drill lists posted payments once', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Cash reviewer', 'cash_reviewer'));
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='cash_reviewer'`));
    state.user = { id: actor, orgId: org.orgId, name: 'Cash reviewer', email: 'cash@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    await withBypassContext(() => db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`));
    await withBypassContext(() => db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD','2026-07-14','spot',1.35,'manual')`));

    const customer = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${customer},${org.orgId},'customer','History Customer',${org.subsidiaryId})`));
    const p1 = await postPaymentDoc(org, customer, org.subsidiaryId, '2026-07-10', 'PAY-100', '100', 'CAD', '1', 'posted');
    // Parallel-book mirror of the same payment.
    const mirrorBook = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${mirrorBook},${org.orgId},'SEC','Secondary',false,true,true)`));
    const mirrorEntry = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
      values (${mirrorEntry},${org.orgId},${mirrorBook},${org.subsidiaryId},${mirrorEntry},'2026-07-10',${org.periodId},'draft','cash',${p1.docId})`));
    await postPaymentLines(org.orgId, mirrorEntry, org.subsidiaryId, customer, '2026-07-10', org.accounts.bank, org.accounts.ar, '100', 'CAD');
    await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${mirrorEntry}`));
    await postPaymentDoc(org, customer, org.subsidiaryId, '2026-07-11', 'PAY-DRAFT', '60', 'CAD', '1', 'draft');
    await postPaymentDoc(org, customer, org.subsidiaryId, '2026-07-12', 'PAY-USD', '100', 'USD', '1.35', 'posted');
    await postPaymentDoc(org, customer, org.subsidiaryId, '2026-07-14', 'PAY-50', '50', 'CAD', '1', 'posted');

    await withOrgContext(org.orgId, async () => {
      const response = await GET(new Request(`http://entity.local/api/analytics/cashflow/entity?party=${customer}&side=ar`));
      assert.equal(response.status, 200);
      const body = await response.json() as RecentsBody;
      assert.deepEqual(body.recentPayments.map((p) => p.docNumber), ['PAY-50', 'PAY-USD', 'PAY-100']);
      const p1row = body.recentPayments.find((p) => p.docNumber === 'PAY-100')!;
      assert.equal(p1row.entryId, p1.entryId, 'parallel-book mirror must not duplicate the payment');
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

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
Object.assign(globalThis, { __entityPayments: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__entityPayments.user}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { GET } = await import('./route.ts');

interface PayBody {
  paymentCount: number;
  avgDays: number | null;
  totalPaid: string;
}

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Cash reviewer', 'cash_reviewer'));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='cash_reviewer'`));
  state.user = { id: actor, orgId: org.orgId, name: 'Cash reviewer', email: 'cash@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  return { org, actor };
}

async function postEntry(orgId: string, bookId: string, sub: string, periodId: string, date: string, debit: string, credit: string, amount: string, party: string, docId: string | null, openItem = false) {
  const entryId = randomUUID();
  const debitLine = randomUUID();
  const creditLine = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entryId},${orgId},${bookId},${sub},${entryId},${date},${periodId},'draft','manual',${docId})`));
  await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${debitLine},${orgId},${entryId},1,${debit},${sub},${party},${openItem},${amount},'CAD',${amount},1,${date}),
           (${creditLine},${orgId},${entryId},2,${credit},${sub},${party},${openItem},-${amount}::numeric,'CAD',-${amount}::numeric,1,${date})`));
  await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${entryId}`));
  return { entryId, debitLine, creditLine };
}

async function postDoc(orgId: string, kind: string, number: string, party: string, sub: string, periodId: string, date: string, total: string) {
  const docId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
    values (${docId},${orgId},${kind},${number},${date},${date},${party},${sub},'CAD',${total},0,${total})`));
  return docId;
}

async function apply(orgId: string, actor: string, fromLine: string, toLine: string, amount: string, date: string) {
  await withBypassContext(() => db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
    values (${orgId},${fromLine},${toLine},${amount},${amount},${amount},'CAD',${amount},'CAD',1,'same_currency','entity-test',${date},${actor})`));
}

async function getPay(party: string, side: string): Promise<PayBody> {
  const response = await GET(new Request(`http://entity.local/api/analytics/cashflow/entity?party=${party}&side=${side}`));
  assert.equal(response.status, 200);
  return await response.json() as PayBody;
}

async function postFxEntry(org: { orgId: string; bookId: string; periodId: string }, sub: string, party: string, date: string, debit: string, credit: string, amount: string, currency: string, openItem: boolean, docId: string | null) {
  const entryId = randomUUID();
  const debitLine = randomUUID();
  const creditLine = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entryId},${org.orgId},${org.bookId},${sub},${entryId},${date},${org.periodId},'draft','manual',${docId})`));
  await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${debitLine},${org.orgId},${entryId},1,${debit},${sub},${party},${openItem},${amount},${currency},${amount},1,${date}),
           (${creditLine},${org.orgId},${entryId},2,${credit},${sub},${party},${openItem},-${amount}::numeric,${currency},-${amount}::numeric,1,${date})`));
  await withBypassContext(() => db.execute(sql`update journal_entries set status='posted' where id=${entryId}`));
  return { entryId, debitLine, creditLine };
}

async function applyFx(orgId: string, actor: string, fromLine: string, toLine: string, amount: string, currency: string, date: string) {
  await withBypassContext(() => db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
    values (${orgId},${fromLine},${toLine},${amount},${amount},${amount},${currency},${amount},${currency},1,'same_currency','entity-fx-test',${date},${actor})`));
}

test('entity drill counts distinct payment documents with weighted days', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, actor } = await setup();
  try {
    const customer = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${customer},${org.orgId},'customer','Split Customer',${org.subsidiaryId})`));
    const billA = await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, '2026-07-01', org.accounts.ar, org.accounts.revenue, '90', customer, null, true);
    const billB = await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, '2026-07-14', org.accounts.ar, org.accounts.revenue, '10', customer, null, true);
    const payDoc = await postDoc(org.orgId, 'customer_payment', 'PAY-SPLIT', customer, org.subsidiaryId, org.periodId, org.date, '100');
    const pay = await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, org.date, org.accounts.bank, org.accounts.ar, '100', customer, payDoc, true);
    await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${pay.entryId},posting_period_id=${org.periodId} where id=${payDoc}`));
    await apply(org.orgId, actor, pay.creditLine, billA.debitLine, '90', org.date);
    await apply(org.orgId, actor, pay.creditLine, billB.debitLine, '10', org.date);
    await withOrgContext(org.orgId, async () => {
      const body = await getPay(customer, 'ar');
      assert.equal(body.paymentCount, 1);
      assert.equal(body.avgDays, 13);
      assert.equal(Number(body.totalPaid), 100);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

/**
 * Credits settle balances without cash moving: a bill settled only by a
 * customer (or vendor) credit changes no payment count, no days and no total
 * paid.
 */
for (const side of ['ar', 'ap'] as const) {
  test(`entity drill excludes ${side === 'ar' ? 'customer' : 'vendor'} credits from payment stats (${side})`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const { org, actor } = await setup();
    try {
      const isAr = side === 'ar';
      const partyKind = isAr ? 'customer' : 'vendor';
      const party = randomUUID();
      await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${party},${org.orgId},${partyKind},'Credit Party',${org.subsidiaryId})`));
      const billEntry = isAr
        ? await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, '2026-07-05', org.accounts.ar, org.accounts.revenue, '50', party, null, true)
        : await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, '2026-07-05', org.accounts.cogs, org.accounts.ap, '70', party, null, true)
      const creditKind = isAr ? 'customer_credit' : 'vendor_credit';
      const creditTotal = isAr ? '50' : '70';
      const creditDoc = await postDoc(org.orgId, creditKind, 'CREDIT-1', party, org.subsidiaryId, org.periodId, org.date, creditTotal);
      const credit = isAr
        ? await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, org.date, org.accounts.revenue, org.accounts.ar, creditTotal, party, creditDoc, true)
        : await postEntry(org.orgId, org.bookId, org.subsidiaryId, org.periodId, org.date, org.accounts.ap, org.accounts.cogs, creditTotal, party, creditDoc, true);
      await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${credit.entryId},posting_period_id=${org.periodId} where id=${creditDoc}`));
      // Credit-side AR/AP line settles the bill line.
      const creditLine = isAr ? credit.creditLine : credit.debitLine;
      const billLine = isAr ? billEntry.debitLine : billEntry.creditLine;
      await apply(org.orgId, actor, creditLine, billLine, creditTotal, org.date);
      await withOrgContext(org.orgId, async () => {
        const body = await getPay(party, side);
        assert.equal(body.paymentCount, 0, 'a credit-only settlement is not a payment');
        assert.equal(Number(body.totalPaid), 0);
        assert.equal(body.avgDays, null);
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}

/**
 * An org-wide party settling in two functional frames: 100 CAD paid in the
 * CAD subsidiary plus 100 USD paid in the USD subsidiary reads 235 CAD at a
 * 1.35 spot — never 200. Each application leg translates at its own source
 * date through the flow path, the same path recent payments already use.
 */
test('entity drill translates totalPaid across functional frames', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, actor } = await setup();
  try {
    const usdSub = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usdSub},${org.orgId},${org.subsidiaryId},'US Co','USD','US','{}'::jsonb,false,true,'{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`));
    await withBypassContext(() => db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD','2026-07-01','spot',1.35,'manual')`));

    const party = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${party},${org.orgId},'customer','Two Frame Customer',null)`));

    for (const leg of [
      { sub: org.subsidiaryId, currency: 'CAD', billDate: '2026-07-01', payDate: '2026-07-10', number: 'PAY-CAD' },
      { sub: usdSub, currency: 'USD', billDate: '2026-07-05', payDate: '2026-07-12', number: 'PAY-USD' },
    ]) {
      const bill = await postFxEntry(org, leg.sub, party, leg.billDate, org.accounts.ar, org.accounts.revenue, '100', leg.currency, true, null);
      const docId = randomUUID();
      await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total,fx_rate)
        values (${docId},${org.orgId},'customer_payment',${leg.number},${leg.payDate},${leg.payDate},${party},${leg.sub},${leg.currency},'100',0,'100','1')`));
      const pay = await postFxEntry(org, leg.sub, party, leg.payDate, org.accounts.bank, org.accounts.ar, '100', leg.currency, true, docId);
      await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${pay.entryId},posting_period_id=${org.periodId} where id=${docId}`));
      await applyFx(org.orgId, actor, pay.creditLine, bill.debitLine, '100', leg.currency, leg.payDate);
    }

    await withOrgContext(org.orgId, async () => {
      const body = await getPay(party, 'ar');
      assert.equal(body.paymentCount, 2);
      assert.equal(body.avgDays, 8);
      assert.equal(Number(body.totalPaid), 235);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

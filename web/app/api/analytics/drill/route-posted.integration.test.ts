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
Object.assign(globalThis, { __analyticsDrillPosted: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsDrillPosted.user}' };
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

async function insertEntry(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string; accounts: { cogs: string; ap: string; ar: string; revenue: string } }, opts: {
  bookId: string; status: string; amount: string; number: string; docId?: string; debit?: string; credit?: string;
}) {
  const debit = opts.debit ?? org.accounts.cogs;
  const credit = opts.credit ?? org.accounts.ap;
  const entryId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entryId},${org.orgId},${opts.bookId},${org.subsidiaryId},${opts.number},${org.date},${org.periodId},'draft','manual',${opts.docId ?? null})`));
  await withBypassContext(() => db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${randomUUID()},${org.orgId},${entryId},1,${debit},${org.subsidiaryId},false,${opts.amount},'CAD',${opts.amount},1,${org.date}),
           (${randomUUID()},${org.orgId},${entryId},2,${credit},${org.subsidiaryId},false,-${opts.amount}::numeric,'CAD',-${opts.amount}::numeric,1,${org.date})`));
  if (opts.status !== 'draft') {
    await withBypassContext(() => db.execute(sql`update journal_entries set status=${opts.status} where id=${entryId}`));
  }
  return entryId;
}

/**
 * The drill must read the same posted population as its parent metrics: a
 * draft journal and a parallel-book mirror are not real activity, and a
 * draft invoice is not revenue — the clicked KPI excludes all of them.
 */
test('analytics drill reads the posted statement-book population only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Drill reviewer', 'drill_reviewer'));
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb,subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='drill_reviewer'`));
    state.user = { id: actor, orgId: org.orgId, name: 'Drill reviewer', email: 'drill@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };

    await insertEntry(org, { bookId: org.bookId, status: 'posted', amount: '100', number: 'POSTED-1' });
    await insertEntry(org, { bookId: org.bookId, status: 'draft', amount: '100', number: 'DRAFT-1' });
    const mirrorBook = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${mirrorBook},${org.orgId},'SEC','Secondary',false,true,true)`));
    await insertEntry(org, { bookId: mirrorBook, status: 'posted', amount: '50', number: 'MIRROR-1' });

    const vendor = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${vendor},${org.orgId},'vendor','Drill Vendor',${org.subsidiaryId})`));
    const postedInvoice = randomUUID();
    const draftInvoice = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
      values (${postedInvoice},${org.orgId},'customer_invoice','POSTED-INV',${org.date},${org.date},${vendor},${org.subsidiaryId},'CAD','300',0,'300'),
             (${draftInvoice},${org.orgId},'customer_invoice','DRAFT-INV',${org.date},${org.date},${vendor},${org.subsidiaryId},'CAD','400',0,'400')`));
    const invoiceEntry = await insertEntry(org, { bookId: org.bookId, status: 'posted', amount: '300', number: 'INV-ENTRY', docId: postedInvoice, debit: org.accounts.ar, credit: org.accounts.revenue });
    await withBypassContext(() => db.execute(sql`update documents set status='posted',posted_entry_id=${invoiceEntry},posting_period_id=${org.periodId} where id=${postedInvoice}`));

    await withOrgContext(org.orgId, async () => {
      const accountRes = await GET(
        new Request(`http://drillposted.local/api/analytics/drill?account=${org.accounts.cogs}&from=${FROM}&to=${TO}`),
      );
      assert.equal(accountRes.status, 200);
      const accountBody = await accountRes.json() as { count: number; total: string };
      assert.equal(accountBody.count, 1, 'draft journal and parallel-book mirror are not activity');
      assert.equal(accountBody.total, '100');

      const partyRes = await GET(
        new Request(`http://drillposted.local/api/analytics/drill?party=${vendor}&from=${FROM}&to=${TO}`),
      );
      assert.equal(partyRes.status, 200);
      const partyBody = await partyRes.json() as { count: number; entries: Array<{ docNumber: string }> };
      assert.equal(partyBody.count, 1, 'draft invoice is not revenue');
      assert.equal(partyBody.entries[0]!.docNumber, 'POSTED-INV');
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

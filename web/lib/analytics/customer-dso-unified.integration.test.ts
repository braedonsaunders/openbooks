import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// DSO has ONE definition: the settlement-weighted trailing mean from
// paymentStats (cash cockpit, cashflow analytics, MCP cashflow tool,
// get_vitals all read it). The customer-intelligence header "Avg DSO" used
// its own grain — an unweighted mean across customers of per-customer
// fully-paid-invoice averages — so on a skewed book (one slow whale, many
// fast small payers) the two surfaces quoted different DSOs for the same org
// on the same day. The header now reads the single engine definition.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { customerData } = await import('./customer-data.ts');
const { paymentStats } = await import('../cash/core.ts');

const DB = !!process.env.OPENBOOKS_DB_URL;

async function party(orgId: string, name: string) {
  const id = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'customer', ${name}, true, '{}'::jsonb)`);
  return id;
}

test('customer-intelligence Avg DSO equals the cash DSO on a skewed book', { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, 'DSO Controller', 'admin'));
    const { slow, fast } = await withBypass(async () => ({
      slow: await party(org.orgId, 'Slow Whale'),
      fast: await party(org.orgId, 'Fast Minnow'),
    }));

    async function invoice(partyId: string, total: string, invoicedOn: string) {
      const id = randomUUID(), entryId = randomUUID(), lineId = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
        values (${id},${org.orgId},'customer_invoice',${id},${invoicedOn},${invoicedOn},${invoicedOn},${partyId},${org.subsidiaryId},'CAD',${total},0,${total})`);
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
        values (${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},${id},${invoicedOn},${org.periodId},'draft','manual',${id})`);
      await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
        values (${lineId},${org.orgId},${entryId},1,${org.accounts.ar},${org.subsidiaryId},${partyId},true,${total},'CAD',${total},1,${invoicedOn}),
        (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.revenue},${org.subsidiaryId},${partyId},false,-${total}::numeric,'CAD',-${total}::numeric,1,${invoicedOn})`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entryId}`);
      await db.execute(sql`update documents set status='posted',posted_entry_id=${entryId},posting_period_id=${org.periodId} where id=${id}`);
      return lineId;
    }

    async function pay(partyId: string, billLine: string, total: string, paidOn: string) {
      const entryId = randomUUID(), lineId = randomUUID();
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values (${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},${entryId},${paidOn},${org.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
        values (${lineId},${org.orgId},${entryId},1,${org.accounts.ar},${org.subsidiaryId},${partyId},true,-${total}::numeric,'CAD',-${total}::numeric,1,${paidOn}),
        (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.bank},${org.subsidiaryId},${partyId},false,${total},'CAD',${total},1,${paidOn})`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entryId}`);
      await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
        values (${org.orgId},${lineId},${billLine},${total},${total},${total},'CAD',${total},'CAD',1,'same_currency','DSO probe',${paidOn},${actor},${actor})`);
    }

    // One slow whale: $10,000 collected in 30 days.
    // Twenty fast minnows: $100 each collected in 2 days.
    await withBypass(async () => {
      await pay(slow, await invoice(slow, '10000', '2026-07-01'), '10000', '2026-07-31');
      for (let i = 0; i < 20; i++) {
        await pay(fast, await invoice(fast, '100', '2026-07-01'), '100', '2026-07-03');
      }
    });

    const { header, engine } = await withOrgContext(org.orgId, async () => {
      const data = await customerData({ from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, org.orgId, null);
      const stats = await paymentStats('ar', '2026-07-31');
      return { header: data.kpis.avgDaysToPay, engine: stats.globalAvg };
    });
    // Settlement-weighted truth on this fixture: (30 + 20x2) / 21 = 3.33 -> 3.
    // The old per-customer grain read (30 + 2) / 2 = 16.
    assert.equal(engine, 3, 'engine DSO is settlement-weighted');
    assert.equal(header, engine, 'customer-intelligence Avg DSO must equal the cash DSO');
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

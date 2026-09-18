import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The customers-home "Days sales out" tile must read the ONE org DSO — the
// settlement-weighted trailing mean from paymentStats that the cash cockpit,
// cashflow analytics, MCP cashflow tool, get_vitals, and customer
// intelligence all quote. It ran its own DSO-lite SQL, which diverged three
// ways: (1) no settlements read null ("—") while every other surface reads
// the documented 45-day default; (2) party-less settlements counted here but
// are excluded from the engine rollup by design; (3) only the invoice leg was
// subsidiary-scoped while the engine scopes both legs.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) return next(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { customersHome } = await import('./customers.ts');
const { paymentStats } = await import('../cash/core.ts');

const DB = !!process.env.OPENBOOKS_DB_URL;

async function party(orgId: string, name: string) {
  const id = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'customer', ${name}, true, '{}'::jsonb)`);
  return id;
}

async function invoice(org: { orgId: string; subsidiaryId: string; bookId: string; periodId: string; accounts: { ar: string; revenue: string } }, partyId: string | null, total: string, invoicedOn: string) {
  const id = randomUUID(), entryId = randomUUID(), lineId = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},${id},${invoicedOn},${org.periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${lineId},${org.orgId},${entryId},1,${org.accounts.ar},${org.subsidiaryId},${partyId},true,${total},'CAD',${total},1,${invoicedOn}),
    (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.revenue},${org.subsidiaryId},${partyId},false,-${total}::numeric,'CAD',-${total}::numeric,1,${invoicedOn})`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entryId}`);
  return lineId;
}

async function pay(org: { orgId: string; subsidiaryId: string; bookId: string; periodId: string; accounts: { ar: string; bank: string } }, actor: string, partyId: string | null, billLine: string, total: string, paidOn: string) {
  const entryId = randomUUID(), lineId = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},${entryId},${paidOn},${org.periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${lineId},${org.orgId},${entryId},1,${org.accounts.ar},${org.subsidiaryId},${partyId},true,-${total}::numeric,'CAD',-${total}::numeric,1,${paidOn}),
    (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.bank},${org.subsidiaryId},${partyId},false,${total},'CAD',${total},1,${paidOn})`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entryId}`);
  await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
    values (${org.orgId},${lineId},${billLine},${total},${total},${total},'CAD',${total},'CAD',1,'same_currency','DSO home probe',${paidOn},${actor},${actor})`);
}

test('customers-home DSO reads the documented 45-day default with no settlements', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const home = await withOrgContext(org.orgId, () => customersHome(org.orgId));
    assert.equal(home.dso, 45, 'empty history must read the single DSO default, not null');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('customers-home DSO excludes party-less settlements like the engine rollup', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Home DSO', 'admin'));
    const customer = await withBypassContext(() => party(org.orgId, 'Real Customer'));
    // One ordinary 10-day settlement pins the engine DSO at 10.
    await withBypassContext(async () => pay(org, actor, customer, await invoice(org, customer, '500', '2026-07-01'), '500', '2026-07-11'));
    // A party-less 71-day settlement: kernel-legal (null matches null) but
    // outside the engine definition, which keys statistics per party.
    await withBypassContext(async () => pay(org, actor, null, await invoice(org, null, '1000', '2026-07-01'), '1000', '2026-09-10'));
    const { home, engine } = await withOrgContext(org.orgId, async () => ({
      home: await customersHome(org.orgId),
      engine: (await paymentStats('ar', '2026-09-16')).globalAvg,
    }));
    assert.equal(engine, 10, 'engine DSO ignores the party-less settlement');
    assert.equal(home.dso, engine, 'home tile must equal the engine DSO');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

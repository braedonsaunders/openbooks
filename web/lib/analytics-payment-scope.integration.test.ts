import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier,context,next) {
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return {shortCircuit:true,url:'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}'};
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  return next(specifier,context);
} });
const {sql} = await import('drizzle-orm');
const {db,withOrgContext} = await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,createScratchUser,dropScratchOrg} = await import('@openbooks/engine/src/test-fixtures.ts');
const {customerData} = await import('./analytics/customer-data');
const {vendorData} = await import('./analytics/vendor-data');
for (const side of ['ar','ap'] as const) {
  for (const mode of ['all','restricted','empty'] as const) {
    test(`Analytics payment-history subsidiary scope ${side}: ${mode}`, {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await createScratchOrg();
      try {
        const actor=await createScratchUser(org.orgId,'History writer','admin');
        const hidden=randomUUID();const party=side === 'ar' ? org.customerId : org.vendorId;
        const account=side === 'ar' ? org.accounts.ar : org.accounts.ap;
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
        for(const [sub,paidOn] of [[org.subsidiaryId,'2026-07-06'],[hidden,'2026-07-21']]) {
          const invoiceLine=randomUUID();const paymentLine=randomUUID();
          for(const [payment,line,date] of [[false,invoiceLine,'2026-07-01'],[true,paymentLine,paidOn]] as const) {
            const entry=randomUUID();const document=payment ? null : randomUUID();
            if(document) await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total) values (${document},${org.orgId},${side === 'ar' ? 'customer_invoice' : 'vendor_bill'},${document},${date},${date},${date},${party},${sub},'CAD',1,0,1)`);
            const debit=side === 'ar' ? !payment : payment;
            const amount=debit ? '1' : '-1';const opposite=debit ? '-1' : '1';
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id) values (${entry},${org.orgId},${org.bookId},${sub},${entry},${date},${org.periodId},'draft','manual',${document})`);
            await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate)
              values (${line},${org.orgId},${entry},1,${account},${sub},${party},true,${amount},'CAD',${amount},1),
                (${randomUUID()},${org.orgId},${entry},2,${payment ? org.accounts.bank : side === 'ar' ? org.accounts.revenue : org.accounts.cogs},${sub},${party},false,${opposite},'CAD',${opposite},1)`);
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
            if(document) await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`);
          }
          await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
            values (${org.orgId},${paymentLine},${invoiceLine},1,1,1,'CAD',1,'CAD',1,'same_currency','History scope regression',${paidOn},${actor},${actor})`);
        }
        await withOrgContext(org.orgId,async()=>{
          const allowed=mode === 'all' ? null : new Set(mode === 'empty' ? [] : [org.subsidiaryId]);
          const period={from:'2026-07-01',to:'2026-07-31',label:'Payment scope'};
          const data=side === 'ar' ? await customerData(period,org.orgId,allowed) : await vendorData(period,org.orgId,allowed);
          assert.equal(data.rows.length,mode === 'empty' ? 0 : 1);
          if(mode !== 'empty')assert.equal(data.rows[0]?.avgDaysToPay,mode === 'all' ? side === 'ar' ? 13 : 12.5 : 5);

        });
      } finally {await dropScratchOrg(org.orgId);}
    });
  }
}

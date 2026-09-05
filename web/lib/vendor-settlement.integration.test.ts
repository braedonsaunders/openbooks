import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier,context,next) {
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if(specifier === '../money-server' && context.parentURL?.includes('/analytics/'))return {shortCircuit:true,url:'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}'};
  return next(specifier,context);
} });
const {sql}=await import('drizzle-orm');
const {db,withOrgContext}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,createScratchUser,dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {vendorData}=await import('./analytics/vendor-data');
for(const scenario of ['in-period payment','early payment','partial payment','future payment','future application','secondary-book payment'] as const){
  test(`Vendor settlement metrics: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try{
      const actor=await createScratchUser(org.orgId,'Payment writer','admin');
      const invoice=randomUUID(),taxBook=randomUUID();
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
        values (${invoice},${org.orgId},'vendor_bill',${invoice},'2026-07-01','2026-07-01','2026-07-10',${org.vendorId},${org.subsidiaryId},'CAD',100,0,100)`);
      async function entry(book:string,payment:boolean,date:string){
        const id=randomUUID(),line=randomUUID();
        const amount=payment ? scenario === 'partial payment' ? '40' : '100' : '-100';
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
          values (${id},${org.orgId},${book},${org.subsidiaryId},${id},${date},${org.periodId},'draft','manual',${payment ? null : invoice})`);
        await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,due_date,amount,currency,txn_amount,fx_rate)
          values (${line},${org.orgId},${id},1,${org.accounts.ap},${org.subsidiaryId},${org.vendorId},true,'2026-07-10',${amount},'CAD',${amount},1),
          (${randomUUID()},${org.orgId},${id},2,${payment ? org.accounts.bank : org.accounts.cogs},${org.subsidiaryId},${org.vendorId},false,null,-${amount}::numeric,'CAD',-${amount}::numeric,1)`);
        await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${id}`);
        return {id,line};
      }
      const original=await entry(org.bookId,false,'2026-07-01');
      await db.execute(sql`update documents set status='posted',posted_entry_id=${original.id},posting_period_id=${org.periodId} where id=${invoice}`);
      const book=scenario === 'secondary-book payment' ? taxBook : org.bookId;
      const target=scenario === 'secondary-book payment' ? await entry(book,false,'2026-07-01') : original;
      const paidOn=scenario === 'future payment' ? '2026-07-21' : scenario === 'early payment' ? '2026-07-06' : '2026-07-12';
      const appliedOn=scenario === 'future application' ? '2026-07-21' : paidOn;
      const payment=await entry(book,true,paidOn);
      await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
        values (${org.orgId},${payment.line},${target.line},${scenario === 'partial payment' ? '40' : '100'},${scenario === 'partial payment' ? '40' : '100'},${scenario === 'partial payment' ? '40' : '100'},'CAD',${scenario === 'partial payment' ? '40' : '100'},'CAD',1,'same_currency','Payment cutoff review',${appliedOn},${actor},${actor})`);
      await withOrgContext(org.orgId,async()=>{
        const data=await vendorData({from:'2026-07-01',to:'2026-07-15',label:'Cutoff review'},org.orgId,null);
        const row=data.rows.find(row=>row.id === org.vendorId);assert.ok(row);
        const paid=scenario === 'in-period payment' || scenario === 'early payment';
        assert.equal(row.paidBills,paid ? 1 : 0);
        assert.equal(row.avgDaysToPay,paid ? scenario === 'early payment' ? 5 : 11 : null);
        assert.equal(row.onTimePct,paid ? scenario === 'early payment' ? 1 : 0 : null);
        assert.equal(row.lateSpend,scenario === 'in-period payment' ? 100 : scenario === 'partial payment' ? 40 : 0);
      });
    }finally{await dropScratchOrg(org.orgId);}
  });
}

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
const {createScratchOrg,dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {spendVelocityData}=await import('./analytics/spend-velocity-data');

for(const scenario of ['posted control','draft report','foreign currency','secondary projection'] as const){
  test(`Employee spend reconciles to the ledger: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try{
      const employee=randomUUID(),document=randomUUID(),taxBook=randomUUID();
      const currency=scenario === 'foreign currency' ? 'USD' : 'CAD';
      const base=scenario === 'foreign currency' ? '200' : '100';
      const fx=scenario === 'foreign currency' ? '2' : '1';
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Employee',${org.subsidiaryId})`);
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,fx_rate,subtotal,tax_total,total)
        values (${document},${org.orgId},'expense_report',${document},${org.date},${org.date},${employee},${org.subsidiaryId},${currency},${fx},100,0,100)`);
      async function post(book:string,amount:string,rate:string){
        const entry=randomUUID();
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
          values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual',${document})`);
        await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,party_id,amount,currency,txn_amount,fx_rate)
          values (${org.orgId},${entry},1,${org.accounts.cogs},${org.subsidiaryId},${employee},${amount},${currency},100,${rate}),
          (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${employee},-${amount}::numeric,${currency},-100,${rate})`);
        await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
        return entry;
      }
      const entry=await post(org.bookId,base,fx);
      await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`);
      if(scenario === 'draft report'){
        const draft=randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
          values (${draft},${org.orgId},'expense_report',${draft},${org.date},${org.date},${employee},${org.subsidiaryId},'CAD',900,0,900)`);
      }
      if(scenario === 'secondary projection'){
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await post(taxBook,'700','7');
      }
      await withOrgContext(org.orgId,async()=>{
        const data=await spendVelocityData(org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'Spend review'},null);
        assert.equal(data.summary.expensesTotal,Number(base),'primary ledger control');
        const spender=data.expenseAnalysis.topSpenders.find(row=>row.employeeId === employee);assert.ok(spender);
        assert.equal(spender.totalSpend,Number(base));
        assert.equal(spender.reportCount,1);
      });
    }finally{await dropScratchOrg(org.orgId);}
  });
}

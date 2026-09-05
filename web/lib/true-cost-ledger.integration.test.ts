import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return {shortCircuit:true,url:'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}'};
  return next(specifier,context);
} });
const {sql}=await import('drizzle-orm');
const {db,withOrgContext}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {trueCostData}=await import('./analytics/true-cost-data');

for(const view of ['overhead','prior rate','monthly','applied burden','revenue base','cost base','labor base'] as const){
  for(const scenario of ['posted control','extra books and drafts'] as const){
    test(`True Cost primary ledger ${view}: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await createScratchOrg();
      try{
        await db.execute(sql`update accounts set type='cogs' where id=${org.accounts.cogs}`);
        const taxBook=randomUUID(),department=randomUUID(),employee=randomUUID(),project=randomUUID(),priorPeriod=randomUUID();
        const rent=randomUUID(),wages=randomUUID(),applied=randomUUID(),group=randomUUID();
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id) select ${priorPeriod},${org.orgId},2026,6,'2026-06','2026-06-01','2026-06-30',false,fiscal_calendar_id from accounting_periods where id=${org.periodId}`);
        await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},'Operations')`);
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Worker',${org.subsidiaryId})`);
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'BURDEN','Burden project',${org.customerId},'active',true)`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type) values
          (${rent},${org.orgId},'6601','Office rent','expense'),(${wages},${org.orgId},'6602','Wages','expense'),(${applied},${org.orgId},'4901','Burden applied','income_other')`);
        await db.execute(sql`insert into account_groups(id,org_id,dimension,key,name) values (${group},${org.orgId},'burden','rent','Rent')`);
        await db.execute(sql`insert into account_group_members(org_id,group_id,account_id,dimension) values (${org.orgId},${group},${rent},'burden')`);
        for(const date of ['2026-06-15',org.date])await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,department_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${date},10,${project},${org.items.service},${department},true,4,'approved')`);
        async function entry(book:string,status:'posted'|'draft',date:string,account:string,amount:string){
          const id=randomUUID();
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values (${id},${org.orgId},${book},${org.subsidiaryId},${id},${date},${date === org.date ? org.periodId : priorPeriod},'draft','manual')`);
          await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,amount,currency,txn_amount,fx_rate) values
            (${org.orgId},${id},1,${account},${org.subsidiaryId},${department},${amount},'CAD',${amount},1),
            (${org.orgId},${id},2,${org.accounts.bank},${org.subsidiaryId},${department},-${amount}::numeric,'CAD',-${amount}::numeric,1)`);
          if(status === 'posted')await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${id}`);
        }
        for(const [account,amount] of [[rent,'100'],[wages,'40'],[org.accounts.cogs,'30'],[org.accounts.revenue,'-200'],[applied,'-10']])await entry(org.bookId,'posted',org.date,account!,amount!);
        await entry(org.bookId,'posted','2026-06-15',rent,'50');
        if(scenario === 'extra books and drafts'){
          for(const [book,status,amount] of [[taxBook,'posted','700'],[org.bookId,'draft','900']] as const){
            for(const account of [rent,wages,org.accounts.cogs,org.accounts.revenue,applied])await entry(book,status,org.date,account,account === org.accounts.revenue || account === applied ? '-'+amount : amount);
            await entry(book,status,'2026-06-15',rent,amount);
          }
        }
        await withOrgContext(org.orgId,async()=>{
          const data=await trueCostData(org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'Ledger review'},null);
          if(view === 'overhead')assert.equal(data.kpis.totalOverhead,100);
          if(view === 'prior rate')assert.equal(data.kpis.compositeRateChangePct,100);
          if(view === 'monthly')assert.equal(data.monthly.find(row=>row.month === '2026-07')?.burden,100);
          if(view === 'applied burden'){assert.equal(data.kpis.burdenApplied,10);assert.equal(data.hasBurdenGL,true);}
          if(view === 'revenue base')assert.equal(data.bases.revenue.total,210);
          if(view === 'cost base')assert.equal(data.bases.directCost.total,30);
          if(view === 'labor base')assert.equal(data.bases.laborDollars.total,40);
        });
      }finally{await dropScratchOrg(org.orgId);}
    });
  }
}

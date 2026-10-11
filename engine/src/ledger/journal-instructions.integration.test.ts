import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db,withBypassContext,withOrgContext } from "../platform/db.ts";
import { createScratchOrg,createScratchUser,dropScratchOrg,type ScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "./posting-document.ts";
import { validateJournalInstructions,JournalInstructionError } from "./journal-instructions.ts";
import { runScheduledJournalReversals,assertJournalVoidNotAutomaticallyReversed } from "./journal-reversals.ts";
import { lookupExchangeRate,lookupSpotRate } from "../fx/spot-rate.ts";
import { postEntry } from "../journal/post-entry.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { assignGlAuditNumbers } from "../close/gl-audit-numbering.ts";

const DB=!!process.env.OPENBOOKS_DB_URL;
const controls=(org:ScratchOrg)=>({control:{ar:org.accounts.ar,ap:org.accounts.ap,bank:org.accounts.bank}});
async function controller(org:ScratchOrg):Promise<string>{
 return withBypassContext(async()=>{
  const actor=await createScratchUser(org.orgId,"Financial Controller","financial_controller");
  await db.execute(sql`update app_roles set permissions='["gl.post","gl.read","close.run"]'::jsonb where org_id=${org.orgId} and key='financial_controller'`);
  return actor;
 });
}
async function journal(org:ScratchOrg,actor:string,mode:string,lines:{account:string;amount:string;quantity?:string;unit?:string;currency?:string}[],options:{currency?:string;fx?:string;reverseOn?:string}={}):Promise<string>{
 const id=randomUUID();
 await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate,journal_fx_rate_explicit,journal_mode,journal_reverse_on,subtotal,total,created_by)
 values(${id},${org.orgId},'journal','draft',${`JE-${id}`},${org.subsidiaryId},${org.date},${options.currency??'CAD'},${options.fx??'1'},true,${mode},${options.reverseOn??null},0,0,${actor})`);
 for(const [index,line] of lines.entries())await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,subsidiary_id,amount,quantity,unit,unit_price,journal_currency)
 values(${org.orgId},${id},${index+1},${line.account},${org.subsidiaryId},${line.amount},${line.quantity??'1'},${line.unit??null},${line.amount},${line.currency??null})`);
 // The fixture explicitly supplies an approved source before the native posting command.
 await db.execute(sql`update documents set status='approved',updated_by=${actor} where org_id=${org.orgId} and id=${id}`);
 return id;
}

test("statistical journals post exact non-monetary quantities and refuse money on statistical accounts",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  const account=randomUUID();await db.execute(sql`insert into accounts(id,org_id,number,name,type) values(${account},${org.orgId},'STAT-1','Floor area','statistical')`);
  const id=await journal(org,actor,'statistical',[{account,amount:'0',quantity:'25.1234',unit:'sqm'}]);
  const entry=await postDocument(id,controls(org),{audit:{actorId:actor,source:"ui"}});
  const saved=(await db.execute<{amount:string;txn:string;quantity:string;unit:string;period:string}>(sql`select amount::text,txn_amount::text as txn,quantity::text,unit,period_id as period from journal_lines where org_id=${org.orgId} and entry_id=${entry}`)).rows;
  assert.deepEqual(saved,[{amount:'0.0000',txn:'0.0000',quantity:'25.1234',unit:'sqm',period:org.periodId}]);
  const invalid=await journal(org,actor,'monetary',[{account,amount:'10'},{account:org.accounts.cogs,amount:'-10'}]);
  await assert.rejects(()=>postDocument(invalid,controls(org)),error=>error instanceof JournalInstructionError);
  assert.equal((await db.execute<{count:number}>(sql`select count(*)::int from journal_entries where org_id=${org.orgId} and source_document_id=${invalid}`)).rows[0]?.count,0);
 });}finally{await dropScratchOrg(org.orgId);}
});

test("an approved dated accrual reverses exactly once and retains the original posted history",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  const reverseOn=org.date.slice(0,8)+'16';
  const id=await journal(org,actor,'monetary',[{account:org.accounts.cogs,amount:'10.0001'},{account:org.accounts.ap,amount:'-10.0001'}],{reverseOn});
  const entry=await postDocument(id,controls(org),{audit:{actorId:actor,source:"ui"}});
  const results=await Promise.all([runScheduledJournalReversals({orgId:org.orgId,actorId:actor,asOf:reverseOn}),runScheduledJournalReversals({orgId:org.orgId,actorId:actor,asOf:reverseOn})]);
  assert.equal(results.reduce((count,result)=>count+result.reversed,0),1);
  const proof=(await db.execute<{source:string;status:string;reversals:number;net:string}>(sql`select e.status as source,i.status,(select count(*)::int from journal_entries where org_id=e.org_id and reverses_entry_id=e.id) as reversals,
   (select sum(l.amount)::text from journal_lines l where l.org_id=e.org_id and l.entry_id in(e.id,i.reversal_entry_id)) as net
   from journal_entries e join journal_reversal_instructions i on i.org_id=e.org_id and i.source_entry_id=e.id where e.org_id=${org.orgId} and e.id=${entry}`)).rows[0];
  assert.deepEqual(proof,{source:'posted',status:'completed',reversals:1,net:'0.0000'});
  await assert.rejects(()=>assertJournalVoidNotAutomaticallyReversed(db,org.orgId,id),error=>error instanceof JournalInstructionError);
 });}finally{await dropScratchOrg(org.orgId);}
});

test("named rate types preserve spot lookup and entity posting uses the selected series",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','true'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`insert into fx_rate_types(org_id,key,name) values(${org.orgId},'corporate','Corporate')`);
  await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate,source) values(${org.orgId},'USD','CAD',${org.date},'spot','1.2','manual'),(${org.orgId},'USD','CAD',${org.date},'corporate','1.4','manual')`);
  await db.execute(sql`insert into subsidiary_accounting_preferences(org_id,subsidiary_id,effective_from,posting_rate_type,reason,created_by) values(${org.orgId},${org.subsidiaryId},${org.date},'corporate','Corporate treasury policy',${actor})`);
  assert.equal(await lookupSpotRate(db,org.orgId,'USD','CAD',org.date),'1.2000000000');
  assert.equal(await lookupExchangeRate(db,org.orgId,'USD','CAD',org.date,'corporate'),'1.4000000000');
  const id=await journal(org,actor,'monetary',[{account:org.accounts.cogs,amount:'100'},{account:org.accounts.ap,amount:'-100'}],{currency:'USD',fx:'1.4'});
  const entry=await postDocument(id,controls(org));
  const amounts=(await db.execute<{amount:string;currency:string;txn:string}>(sql`select amount::text,currency,txn_amount::text as txn from journal_lines where org_id=${org.orgId} and entry_id=${entry} order by line_number`)).rows;
  assert.deepEqual(amounts,[{amount:'140.0000',currency:'USD',txn:'100.0000'},{amount:'-140.0000',currency:'USD',txn:'-100.0000'}]);
  await assert.rejects(()=>db.execute(sql`update subsidiary_accounting_preferences set posting_rate_type='spot' where org_id=${org.orgId}`));
 });}finally{await dropScratchOrg(org.orgId);}
});

test("currency adjustment refuses cancellation between two different foreign currency balances",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','true'::jsonb) where id=${org.orgId}`);
  for(const [currency,amount,fx,base] of [['USD','10','1.2','12'],['EUR','-10','1.3','-13']])await postEntry(db,{orgId:org.orgId,bookId:org.bookId,subsidiaryId:org.subsidiaryId,entryNumber:`EXPOSURE-${currency}`,postingDate:org.date,periodId:org.periodId,origin:'manual',lines:[{accountId:org.accounts.bank,amount:base!,currency:currency!,txnAmount:amount!,fxRate:fx!},{accountId:org.accounts.cogs,amount:base==='12'?'-12':'13',currency:'CAD'}]});
  const id=await journal(org,actor,'currency_adjustment',[{account:org.accounts.bank,amount:'1',currency:'USD'},{account:org.accounts.fxGainLoss,amount:'-1'}]);
  await assert.rejects(()=>validateJournalInstructions(db,org.orgId,id,true),error=>error instanceof JournalInstructionError && /zero foreign balance/.test(error.message));
 });}finally{await dropScratchOrg(org.orgId);}
});

test("entity calendars resolve posting and refuse activity in that entity's closed period",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  const calendar=randomUUID();const period=randomUUID();
  await db.execute(sql`insert into fiscal_calendars(id,org_id,name,is_active,is_default) values(${calendar},${org.orgId},'Entity fiscal calendar',true,false)`);
  await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
   select ${period},org_id,${calendar},fiscal_year,period_number,'Entity reporting period',starts_on,ends_on from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`);
  await db.execute(sql`insert into subsidiary_accounting_preferences(org_id,subsidiary_id,effective_from,fiscal_calendar_id,reason,created_by)
   select ${org.orgId},${org.subsidiaryId},starts_on,${calendar},'Entity fiscal calendar assignment',${actor} from accounting_periods where org_id=${org.orgId} and id=${period}`);
  assert.equal((await resolveCoveringPeriod(db,org.orgId,org.date,org.subsidiaryId))?.id,period);
  assert.equal((await resolveCoveringPeriod(db,org.orgId,org.date))?.id,org.periodId);
  const id=await journal(org,actor,'monetary',[{account:org.accounts.cogs,amount:'10'},{account:org.accounts.ap,amount:'-10'}]);
  const entry=await postDocument(id,controls(org));
  assert.equal((await db.execute<{id:string}>(sql`select period_id as id from journal_entries where org_id=${org.orgId} and id=${entry}`)).rows[0]?.id,period);
  await db.execute(sql`insert into period_locks(org_id,period_id,book_id,subsidiary_id,module,state,locked_at,locked_by,reason)
   values(${org.orgId},${period},${org.bookId},${org.subsidiaryId},'gl','closed',now(),${actor},'Controller close')`);
  const closed=await journal(org,actor,'monetary',[{account:org.accounts.cogs,amount:'1'},{account:org.accounts.ap,amount:'-1'}]);
  await assert.rejects(()=>postDocument(closed,controls(org)));
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and source_document_id=${closed}`)).rows[0]?.n,0);
 });}finally{await dropScratchOrg(org.orgId);}
});

test("closed-period GL audit numbering is gapless under concurrent retries and preserves posted entries",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  await db.execute(sql`insert into gl_audit_number_policies(org_id,subsidiary_id,effective_from,reset_rule,prefix,reason,created_by)
   values(${org.orgId},${org.subsidiaryId},${org.date},'period','GL','Statutory audit numbering',${actor})`);
  for(const amount of ['10','20']){const id=await journal(org,actor,'monetary',[{account:org.accounts.cogs,amount},{account:org.accounts.ap,amount:`-${amount}`}]);await postDocument(id,controls(org));}
  const input={orgId:org.orgId,actorId:actor,periodId:org.periodId,bookId:org.bookId,subsidiaryId:org.subsidiaryId,allowedSubsidiaryIds:null,reason:'Period audit numbering'};
  await assert.rejects(()=>assignGlAuditNumbers(input),/Close the entity/);
  await db.execute(sql`insert into period_locks(org_id,period_id,book_id,subsidiary_id,module,state,locked_at,locked_by,reason)
   values(${org.orgId},${org.periodId},${org.bookId},${org.subsidiaryId},'gl','closed',now(),${actor},'Controller close')`);
  const allocations=await Promise.all([assignGlAuditNumbers(input),assignGlAuditNumbers(input)]);
  assert.equal(allocations.reduce((total,result)=>total+result.assigned,0),2);
  const numbers=(await db.execute<{ordinal:number}>(sql`select ordinal from gl_audit_number_assignments where org_id=${org.orgId} order by ordinal`)).rows.map(row=>row.ordinal);
  assert.deepEqual(numbers,[1,2]);
  assert.equal((await assignGlAuditNumbers(input)).assigned,0);
  await assert.rejects(()=>db.execute(sql`delete from gl_audit_number_assignments where org_id=${org.orgId}`));
 });}finally{await dropScratchOrg(org.orgId);}
});

test("adjustment-only books resolve primary plus adjustments while full books retain one physical basis",{skip:!DB},async()=>{
 const org=await createScratchOrg();
 try{await withOrgContext(org.orgId,async()=>{
  const adjustment=randomUUID();const full=randomUUID();
  await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,posts_gl,replication_mode,replication_from)
   values(${adjustment},${org.orgId},'ADJ','Adjustments',false,true,'adjustment_only',null),(${full},${org.orgId},'FULL','Full book',false,true,'full',${org.date})`);
  const basis=async(book:string)=>(await db.execute<{id:string}>(sql`select public.reporting_book_ids(${org.orgId},${book}) as id`)).rows.map(row=>row.id).sort();
  assert.deepEqual(await basis(adjustment),[org.bookId,adjustment].sort());
  assert.deepEqual(await basis(full),[full]);
  assert.deepEqual(await basis(org.bookId),[org.bookId]);
  await assert.rejects(()=>basis(randomUUID()));
 });}finally{await dropScratchOrg(org.orgId);}
});

test("a residual adjustment clears zero foreign exposure and its automatic reversal mirrors the recorded base amount",{skip:!DB},async()=>{
 const org=await createScratchOrg();const actor=await controller(org);
 try{await withOrgContext(org.orgId,async()=>{
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','true'::jsonb) where id=${org.orgId}`);
  for(const [number,txn,rate,base] of [['OPEN','10','1.2','12'],['SETTLE','-10','1.3','-13']]){
   await postEntry(db,{orgId:org.orgId,bookId:org.bookId,subsidiaryId:org.subsidiaryId,entryNumber:number!,postingDate:org.date,periodId:org.periodId,origin:'manual',lines:[
    {accountId:org.accounts.bank,amount:base!,currency:'USD',txnAmount:txn!,fxRate:rate!},
    {accountId:org.accounts.cogs,amount:base==='12'?'-12':'13',currency:'CAD'},
   ]});
  }
  const reverseOn=org.date.slice(0,8)+'16';
  const id=await journal(org,actor,'currency_adjustment',[{account:org.accounts.bank,amount:'1',currency:'USD'},{account:org.accounts.fxGainLoss,amount:'-1'}],{reverseOn});
  const entry=await postDocument(id,controls(org),{audit:{actorId:actor,source:'ui'}});
  const balance=async()=>(await db.execute<{base:string;foreign:string}>(sql`select sum(l.amount)::text as base,sum(case when l.currency='USD' then l.txn_amount else 0 end)::text as foreign from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${org.orgId} and l.account_id=${org.accounts.bank} and e.status in('posted','reversed')`)).rows[0];
  assert.deepEqual(await balance(),{base:'0.0000',foreign:'0.0000'});
  const result=await runScheduledJournalReversals({orgId:org.orgId,actorId:actor,asOf:reverseOn});
  assert.equal(result.reversed,1);assert.deepEqual(result.blocked,[]);
  assert.deepEqual(await balance(),{base:'-1.0000',foreign:'0.0000'});
  const tagged=(await db.execute<{amount:string;txn:string;original:string}>(sql`select l.amount::text,l.txn_amount::text as txn,e.reverses_entry_id as original from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${org.orgId} and e.reverses_entry_id=${entry} and l.is_currency_adjustment`)).rows;
  assert.deepEqual(tagged,[{amount:'-1.0000',txn:'0.0000',original:entry}]);
 });}finally{await dropScratchOrg(org.orgId);}
});

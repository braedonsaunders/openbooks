import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const root=pathToFileURL(process.cwd()+'/').href;
const capture={html:''};
Object.assign(globalThis,{__backupPrecisionCapture:capture});
registerHooks({resolve(specifier,context,next){
  if(specifier==='server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if(context.parentURL?.endsWith('/web/lib/invoice-backup.ts')) {
    if(specifier==='@openbooks/pdf') return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export async function renderHtmlDocumentPdf(input){globalThis.__backupPrecisionCapture.html=input.bodyHtml;throw new Error("captured timesheet HTML")}')};
    if(specifier==='./pdf-templates/store') return {shortCircuit:true,url:'data:text/javascript,export async function resolvePdfTemplate(){return null}'};
    if(specifier==='./money-server') return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`import {createMoneyFormatter} from '${root}web/lib/money-format.ts';export async function getMoneyFormatter(_org,currency){return createMoneyFormatter('en-CA',currency)}`)};
  }
  if(specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const {sql}=await import('drizzle-orm');
const {db}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg,createScratchUser}=await import('@openbooks/engine/src/test-fixtures.ts');
const {assembleInvoiceBackup}=await import('./invoice-backup');
const {createMoneyFormatter}=await import('./money-format');
test('costed invoice backup preserves cents in large exact cost totals',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
    const actor=await createScratchUser(org.orgId,'Backup controller','reviewer');
    const invoice=randomUUID(),line=randomUUID(),employee=randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Backup worker',${org.subsidiaryId})`);
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,currency) values (${invoice},${org.orgId},'customer_invoice',${invoice},${org.date},${org.subsidiaryId},${org.customerId},'CAD')`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${line},${org.orgId},${invoice},1,${org.accounts.revenue},2,1,2)`);
    for(const cost of ['999999999999999.9000','0.0400']) await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,bill_rate,invoiced_by_line_id,billing_status,is_billable,status) values (${org.orgId},${employee},${org.date},1,${cost},'CAD',${org.subsidiaryId},1,${line},'billed',true,'approved')`);
    await assert.rejects(assembleInvoiceBackup(org.orgId,actor,invoice,'costed_timesheets',null),/captured timesheet HTML/);
    const footer=capture.html.split('<tfoot>')[1];
    assert.ok(footer,'the actual timesheet renderer received a totals footer');
    assert.ok(footer.includes(createMoneyFormatter('en-CA','CAD').money('999999999999999.9400')),footer);
  }finally{await dropScratchOrg(org.orgId);}
});

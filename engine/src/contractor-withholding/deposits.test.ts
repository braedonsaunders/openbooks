import assert from 'node:assert/strict';
import test from 'node:test';
import { contractorWithholdingScheme } from '../country-tax-packs/index.ts';
import type { SqlExecutor } from '../platform/db.ts';
import { assertWithholdingDepositEdit, assertWithholdingDepositCurrent, validateWithholdingRemittancePolicy, withholdingDepositPeriod, resolveWithholdingDepositDeadlines } from './deposits.ts';

const us = contractorWithholdingScheme('US_BACKUP_WITHHOLDING')!;
const calendar = { from:'2026-01-01',to:'2027-12-31',closedDates:['2026-04-16','2026-05-25','2027-04-16'],sourceReference:'IRS confirmed legal holidays' };
const policy = { calendar,lookback:{taxYear:2024,totalTax:'50000',sourceReference:'Filed 2024 Form 945'} };

test('monthly accumulation never combines separate months into a next-day threshold',()=>{
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-01-31',policy),'2026-01');
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-02-01',policy),'2026-02');
});
test('semiweekly accumulation closes Wednesday-Friday and Saturday-Tuesday separately',()=>{
  const semi={...policy,lookback:{...policy.lookback,totalTax:'50001'}};
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-05-20',semi),'2026-05-22');
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-05-22',semi),'2026-05-22');
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-05-23',semi),'2026-05-26');
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2026-05-26',semi),'2026-05-26');
});
test('retained next-day event changes periods through the following year then expires',()=>{
  const retained={...policy,nextDayEventOn:'2026-01-31',lookback:{...policy.lookback,taxYear:2025}};
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2027-02-01',retained),'2027-02-02');
  assert.equal(withholdingDepositPeriod(us,'US_LOOKBACK','2028-02-01',{...retained,lookback:{...retained.lookback,taxYear:2026}}),'2028-02');
});
test('authority policy refuses missing evidence, separator amounts and dates outside coverage',()=>{
  assert.throws(()=>validateWithholdingRemittancePolicy(null),/required/);
  assert.throws(()=>validateWithholdingRemittancePolicy({...policy,calendar:{...calendar,sourceReference:''}}),/source reference/);
  assert.throws(()=>validateWithholdingRemittancePolicy({...policy,lookback:{...policy.lookback,totalTax:'50,000'}}),/exact/);
  assert.throws(()=>validateWithholdingRemittancePolicy({...policy,calendar:{...calendar,closedDates:['2028-01-01']}}),/outside/);
  assert.throws(()=>validateWithholdingRemittancePolicy({...policy,other945Liabilities:[{date:'2026-05-01',amount:'1',sourceReference:''}]}),/source references/);
  assert.deepEqual(validateWithholdingRemittancePolicy({...policy,other945Liabilities:[{date:'2026-05-01',amount:'12.34',sourceReference:'Pension withholding ledger'}]}).other945Liabilities?.[0]?.amount,'12.34');
});
function executor(rows:Record<string,unknown>[][]):SqlExecutor { let index=0; return {execute:async()=>({rows:rows[index++]??[],rowCount:1})} as unknown as SqlExecutor; }
test('deposit bill dates, authority and line amounts are protected while equivalent native saves remain supported',async()=>{
  const header={kind:'vendor_bill',currency:'USD',subsidiaryId:'entity',partyId:'irs',documentDate:'2026-05-22',dueDate:'2026-06-15',fxRate:'1',subtotal:'24',taxTotal:'0',total:'24'};
  const line={id:'line',lineNumber:1,accountId:'liability',description:'Authority deposit',quantity:'1',unitPrice:'24',amount:'24',taxAmount:'0',withholdingTreatment:'excluded'};
  const source={financialSnapshot:{header,lines:[line]}};
  const snake=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),value]));
  const prepare=()=>executor([[{id:'doc'}],[{...snake(header),custom:{withholdingDeposit:source}}],[snake(line)],[],[{source}]]);
  assert.equal(await assertWithholdingDepositEdit(prepare(),'org','doc',null,{}),true);
  assert.equal(await assertWithholdingDepositEdit(prepare(),'org','doc',[{...line,amount:'24.0000',quantity:'1.00000000',taxInputAmount:'24'}],{memo:'Reviewed deposit'}),true);
  for(const patch of [{dueDate:'2026-07-01'},{documentDate:'2026-05-21'},{partyId:'other'},{currency:'EUR'},{subsidiaryId:null},{fxRate:'1.1'}]) await assert.rejects(()=>assertWithholdingDepositEdit(prepare(),'org','doc',null,patch),/retains/);
  for(const changed of [{amount:'25'},{unitPrice:'25'},{accountId:'other'},{taxCodeId:'tax'},{taxAmount:'1'},{withholdingTreatment:'labour'},{custom:{source:'changed'}}]) await assert.rejects(()=>assertWithholdingDepositEdit(prepare(),'org','doc',[{...line,...changed}],{}),/retains/);
  await assert.rejects(()=>assertWithholdingDepositEdit(prepare(),'org','doc',[],{}),/retains/);
  assert.equal(await assertWithholdingDepositEdit(executor([[]]),'org','doc',null,{}),false);
  for(const storedLine of [{...line,amount:'25'},{...line,accountId:'other'},{...line,taxAmount:'1'},{...line,custom:{economicSource:'replacement'}}]) {
    await assert.rejects(()=>assertWithholdingDepositEdit(executor([[{id:'doc'}],[{...snake(header),custom:{withholdingDeposit:source}}],[snake(storedLine)],[],[{source}]]),'org','doc',null,{memo:'Cannot bless changed source'}),/retains/);
  }
  await assert.rejects(()=>assertWithholdingDepositEdit(executor([[{id:'doc'}],[{...snake(header),custom:{}}],[snake(line)],[],[{source}]]),'org','doc',null,{}),/retains/);
  await assert.rejects(()=>assertWithholdingDepositEdit(executor([[{id:'doc'}],[{...snake(header),custom:{withholdingDeposit:source}}],[snake(line)],[],[]]),'org','doc',null,{}),/retains/);
});
test('source guard fails closed for malformed identity or reversed deductions',async()=>{
  await assert.rejects(()=>assertWithholdingDepositCurrent(executor([[{source:{enrollmentId:'invalid'},total:'24'}]]),'org','doc'),/identity/);
  const source={enrollmentId:'00000000-0000-4000-8000-000000000001',deductionIds:['00000000-0000-4000-8000-000000000002'],snapshotSha256:'old',sourceFX:{rate:'1',asOf:'2026-05-22'}};
  await assert.rejects(()=>assertWithholdingDepositCurrent(executor([[{source,total:'24',fx_rate:'1',document_date:'2026-05-22'}],[],[]]),'org','doc'),/no longer matches/);
});


test('other Form 945 liabilities accelerate native deductions without entering their payable amount',()=>{
  const decision=resolveWithholdingDepositDeadlines(us,'US_LOOKBACK',[{date:'2026-05-01',amount:'10000'},{date:'2026-05-04',amount:'95000'}],policy);
  assert.equal(decision.deadlines.get('2026-05-01'),'2026-05-05');
  assert.equal(decision.nextDayEventOn,'2026-05-04');
});
test('separate monthly $60,000 liabilities do not invent a $100,000 next-day event',()=>{
  const decision=resolveWithholdingDepositDeadlines(us,'US_LOOKBACK',[{date:'2026-05-01',amount:'60000'},{date:'2026-06-01',amount:'60000'}],policy);
  assert.equal(decision.deadlines.get('2026-05-01'),'2026-06-15');
  assert.equal(decision.deadlines.get('2026-06-01'),'2026-07-15');
  assert.equal(decision.nextDayEventOn,undefined);
});
test('the next-day threshold resets its liability bucket after the triggering event',()=>{
  const decision=resolveWithholdingDepositDeadlines(us,'US_LOOKBACK',[{date:'2026-05-20',amount:'100000'},{date:'2026-05-21',amount:'1'}],policy);
  assert.equal(decision.deadlines.get('2026-05-20'),'2026-05-21');
  assert.equal(decision.deadlines.get('2026-05-21'),'2026-05-28');
});

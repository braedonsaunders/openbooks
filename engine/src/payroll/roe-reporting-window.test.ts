import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRoeReportingWindow, type RoeWindowContext, type RoeCalendarPeriod, type RoeWindowStub } from './roe-reporting-window.ts';
import { at, iso, DAY } from './run-calendar.ts';
const context=(first:string,last:string):RoeWindowContext=>({orgId:'org',employeeId:'employee',name:'Worker',employmentId:'employment',subsidiaryId:'employer',scheduleId:'schedule',frequency:'weekly',filingAccountId:'filing',event:{id:'event',employment_id:'employment',subsidiary_id:'employer',first_day_worked:first,last_insurable_earnings_on:last,interruption_on:last,salary_continuance_end_on:null,source_reference:'Employer employment-spell record'}});
function fixture(count:number){
 const calendar:RoeCalendarPeriod[]=[],stubs:RoeWindowStub[]=[];
 for(let i=0;i<count;i++){
  const start=iso(new Date(at('2025-01-05').getTime()+i*7*DAY));
  const end=iso(new Date(at(start).getTime()+6*DAY));
  const payDate=iso(new Date(at(end).getTime()+3*DAY));
  calendar.push({periodStart:start,periodEnd:end,payDate,documentId:'regular-'+i,runType:'regular',explicitlyExcluded:false});
  stubs.push({id:'stub-'+i,documentId:'regular-'+i,subsidiaryId:'employer',employmentId:'employment',filingAccountId:'filing',currency:'CAD',hoursBasisQualified:true,periodStart:start,periodEnd:end,payDate,insurableEarnings:'100.01',insurableHours:'7.75',earnedFrom:start,earnedTo:end,earnedDatesComplete:true});
 }
 return {calendar,stubs};
}
test('ROE groups supplemental and later-paid dated earnings into the final service period and retains distinct statutory windows',()=>{
 const {calendar,stubs}=fixture(53);const last=calendar.at(-1)!;
 stubs.push({...stubs.at(-1)!,id:'supplemental',documentId:'supplemental',periodStart:last.periodEnd,periodEnd:last.periodEnd,payDate:'2026-02-01',earnedFrom:last.periodEnd,earnedTo:last.periodEnd,insurableEarnings:'10.03',insurableHours:'1.25'});
 stubs.push({...stubs.at(-1)!,id:'later-adjustment',documentId:'later-adjustment',periodStart:'2026-02-01',periodEnd:'2026-02-07',payDate:'2026-02-10',earnedFrom:last.periodEnd,earnedTo:last.periodEnd,insurableEarnings:'3.42',insurableHours:'0'});
 const window=assembleRoeReportingWindow(context(calendar[0]!.periodStart,last.periodEnd),calendar,stubs);
 assert.equal(window.periods.length,53);assert.equal(window.periods[0]!.periodEnd,last.periodEnd);
 assert.equal(window.periods[0]!.insurableEarnings,'113.4600');
 assert.equal(window.totalInsurableHours,'412.0000');assert.equal(window.totalInsurableEarnings,'2713.7200');
 assert.equal(window.sourceDocuments.length,55);assert.equal(window.sourceDocuments.at(-1)!.documentId,'later-adjustment');
});
test('an explicitly excluded nil period retains its consecutive position rather than pulling in an earlier cheque',()=>{
 const {calendar,stubs}=fixture(3);calendar[1]!.explicitlyExcluded=true;stubs.splice(1,1);
 const window=assembleRoeReportingWindow(context(calendar[0]!.periodStart,calendar[2]!.periodEnd),calendar,stubs);
 assert.equal(window.periods.length,3);assert.equal(window.periods[1]!.insurableEarnings,'0');
 assert.equal(window.totalInsurableEarnings,'200.0200');assert.equal(window.totalInsurableHours,'15.5000');
});
test('ROE refuses absent history and unqualified nil periods instead of inventing zero coverage',()=>{
 const {calendar,stubs}=fixture(3);const ctx=context(calendar[0]!.periodStart,calendar[2]!.periodEnd);
 assert.throws(()=>assembleRoeReportingWindow(ctx,[calendar[0]!,calendar[2]!],stubs),/gap or overlap/);
 assert.throws(()=>assembleRoeReportingWindow(ctx,calendar,stubs.filter(s=>s.id!=='stub-1')),/no retained pay or explicit no-pay/);
 assert.throws(()=>assembleRoeReportingWindow(context('2024-12-01',calendar[2]!.periodEnd),calendar,stubs),/earlier committed payroll coverage/);
});
test('ROE refuses ambiguous calendars, conflicting employment and missing historical hours attribution',()=>{
 const {calendar,stubs}=fixture(1);const ctx=context(calendar[0]!.periodStart,calendar[0]!.periodEnd);
 assert.throws(()=>assembleRoeReportingWindow(ctx,[...calendar,{...calendar[0]!,documentId:'duplicate'}],stubs),/same ROE service period/);
 assert.throws(()=>assembleRoeReportingWindow(ctx,calendar,[{...stubs[0]!,employmentId:null}]),/unknown or conflicting/);
 assert.throws(()=>assembleRoeReportingWindow(ctx,calendar,[{...stubs[0]!,hoursBasisQualified:false}]),/retained insurable-hour attribution/);
 assert.throws(()=>assembleRoeReportingWindow(context(calendar[0]!.periodEnd,calendar[0]!.periodEnd),calendar,stubs),/before the confirmed first day worked/);
});
test('ROE refuses cross-period aggregate allocation while preserving its source facts',()=>{
 const {calendar,stubs}=fixture(2);const ctx=context(calendar[0]!.periodStart,calendar[1]!.periodEnd);
 const spanning={...stubs[0]!,id:'retro',earnedTo:calendar[1]!.periodEnd};
 const before=JSON.stringify(spanning);
 assert.throws(()=>assembleRoeReportingWindow(ctx,calendar,[spanning]),/spanning multiple ROE service periods/);
 assert.equal(JSON.stringify(spanning),before);
});

test('a retained final-pay period occupies one reporting position with or without its regular run',()=>{
 const {calendar,stubs}=fixture(1);const ctx=context(calendar[0]!.periodStart,calendar[0]!.periodEnd);
 const termination={...calendar[0]!,documentId:'termination',runType:'termination' as const};
 const finalStub={...stubs[0]!,id:'final-stub',documentId:'termination',insurableEarnings:'25',insurableHours:'1'};
 const combined=assembleRoeReportingWindow(ctx,[...calendar,termination],[...stubs,finalStub]);
 assert.equal(combined.periods.length,1);assert.equal(combined.totalInsurableEarnings,'125.0100');
 assert.deepEqual(combined.calendarDocuments,['regular-0','termination']);
 const finalOnly=assembleRoeReportingWindow(ctx,[termination],[finalStub]);
 assert.equal(finalOnly.periods.length,1);assert.equal(finalOnly.totalInsurableHours,'1.0000');
 assert.throws(()=>assembleRoeReportingWindow(ctx,[termination,{...termination,documentId:'another-final'}],[finalStub]),/same ROE service period/);
});

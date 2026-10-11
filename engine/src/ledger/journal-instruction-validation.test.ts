import assert from "node:assert/strict";
import test from "node:test";
import { validateJournalInstructionLines,JournalInstructionError,type JournalInstructionLine } from "./journal-instruction-validation.ts";
import { assertFinalKernelBalance } from "../journal/posting-invariants.ts";
const measurement:JournalInstructionLine={line_number:1,type:'statistical',amount:'0',quantity:'12.1234',unit:'sqm',journal_currency:null,journal_fx_rate:null,journal_eliminate:false,template:null};
test('statistical measurements require exact quantities and never accept money or monetary accounts',()=>{
 assert.doesNotThrow(()=>validateJournalInstructionLines('statistical',null,[measurement]));
 for(const change of [{quantity:'0'},{quantity:'0.00001'},{unit:''},{amount:'0.0001'},{type:'asset_other'},{journal_currency:'USD'},{journal_eliminate:true}]){
  assert.throws(()=>validateJournalInstructionLines('statistical',null,[{...measurement,...change}]),JournalInstructionError);
 }
 assert.throws(()=>validateJournalInstructionLines('monetary',null,[measurement]),JournalInstructionError);
});
test('a single non-monetary measurement is valid but an empty or one-sided monetary posting refuses',()=>{
 assert.doesNotThrow(()=>assertFinalKernelBalance([{amount:'0',subsidiaryId:'entity',quantity:'12.1234',unit:'sqm'}]));
 assert.throws(()=>assertFinalKernelBalance([{amount:'0',subsidiaryId:'entity'}]));
 assert.throws(()=>assertFinalKernelBalance([{amount:'1',subsidiaryId:'entity',quantity:'12',unit:'sqm'}]));
 assert.throws(()=>assertFinalKernelBalance([]));
});
test('an expense deferral and full scheduled reversal cannot both control the same source expense',()=>{
 assert.throws(()=>validateJournalInstructionLines('monetary','2026-08-01',[{...measurement,type:'expense',amount:'10',template:'expense-template'}]),JournalInstructionError);
});

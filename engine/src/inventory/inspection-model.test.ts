import assert from "node:assert/strict";
import test from "node:test";
import { inspectionDecimal, inspectionMeasures, inspectionOutcome, type InspectionPlanSnapshot } from "./inspection-model.ts";

const plan:InspectionPlanSnapshot={id:"0195d40a-128b-7000-8000-000000000001",name:"Finished dimension",point:"operation",operationSequence:10,
  measures:inspectionMeasures([{key:"length",label:"Length",unit:"mm",required:true,minimum:"-0.0001",maximum:"999999999999999.9999"},{key:"note_value",label:"Optional reading",unit:"",required:false}])};

test("inspection limits remain exact at the ledger range and cannot be overridden by pass",()=>{
  assert.equal(inspectionOutcome(plan,"pass",{length:"999999999999999.9999"}),"pass");
  assert.equal(inspectionOutcome(plan,"pass",{length:"-0.0002"}),"fail");
  assert.equal(inspectionOutcome(plan,"fail",{length:"1.0000"}),"fail");
  assert.equal(inspectionOutcome(plan,"pass",{length:"-0.0001",note_value:""}),"pass");
  assert.throws(()=>inspectionOutcome(plan,"pass",{}),/Enter Length/);
  assert.throws(()=>inspectionOutcome(plan,"pass",{length:"1",unknown:"0"}),/not part/);
  for(const value of ["1e3","1,000","0.00001","1000000000000000","NaN",Infinity,null]) assert.throws(()=>inspectionDecimal(value,"Reading"),/exact number/);
});

test("inspection plans reject ambiguous keys, inverted limits and oversized detail",()=>{
  const measurement={key:"size",label:"Size",unit:"mm",required:true};
  assert.throws(()=>inspectionMeasures([measurement,measurement]),/distinct key/);
  assert.throws(()=>inspectionMeasures([{...measurement,minimum:"2",maximum:"1.9999"}]),/minimum/);
  assert.throws(()=>inspectionMeasures(Array.from({length:101},(_,i)=>({...measurement,key:'size_'+i}))),/100/);
  assert.throws(()=>inspectionMeasures([{...measurement,key:"__proto__"}]),/distinct key/);
  const input=[measurement];const normalized=inspectionMeasures(input);normalized[0]!.label="Changed";
  assert.equal(input[0]!.label,"Size","plan validation does not mutate the caller's draft");
});

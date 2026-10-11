import assert from "node:assert/strict";
import test from "node:test";
import { genericBalancingGroups } from "./generic-balancing.ts";
import type { BalancingLineView } from "./balancing-hooks.ts";

const line=(amount:string,extraDims:Record<string,unknown>,overrides:Partial<BalancingLineView>={}):BalancingLineView=>({accountId:"expense",amount,subsidiaryId:"entity",currency:"CAD",txnAmount:amount,fxRate:"1",extraDims,...overrides});

test("generic balancing preserves simultaneous dimensions and exact fractional amounts",()=>{
 const source=[line("12.0001",{fund:"a",purpose:"x"},{departmentId:"north"}),line("-12.0001",{fund:"b",purpose:"y"},{departmentId:"south"})];
 const groups=genericBalancingGroups(source);
 assert.equal(groups.length,2);
 assert.equal(groups.reduce((total,group)=>total+group.amount,0n),0n);
 for(const original of source){
  const group=groups.find(value=>value.extraDims.fund===original.extraDims?.fund)!;
  assert.equal(group.departmentId,original.departmentId);
  assert.deepEqual(group.extraDims,original.extraDims);
 }
});

test("dimension key order and source line order do not change generic balancing output",()=>{
 const first=[line("3.0000",{fund:"a",purpose:"x"}),line("2.0000",{purpose:"x",fund:"a"}),line("-5.0000",{fund:"b",purpose:"y"})];
 assert.deepEqual(genericBalancingGroups(first),genericBalancingGroups([...first].reverse()));
 assert.deepEqual(genericBalancingGroups([line("5",{fund:"a"}),line("-5",{fund:"a"})]),[]);
});

test("null assignments and subsidiary boundaries remain separate balancing obligations",()=>{
 const groups=genericBalancingGroups([line("4",{fund:null}),line("-4",{fund:"a"}),line("1",{fund:null},{subsidiaryId:"other"}),line("-1",{fund:"a"},{subsidiaryId:"other"})]);
 assert.equal(groups.length,4);
 assert.equal(groups.filter(group=>group.subsidiaryId==="other").length,2);
 assert.equal(groups.filter(group=>Object.keys(group.extraDims).length===0).length,2);
});

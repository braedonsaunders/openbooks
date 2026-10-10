import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sum, toUnits } from '../money/money.ts';
import { allocateJointProductionCost } from './production-outputs.ts';

test('joint outputs allocate exact costs by quantity and relative unit weight',()=>{
  const outputs=[{itemId:'primary',quantity:'100',costWeight:'1'},{itemId:'joint',quantity:'10',costWeight:'5'}];
  assert.deepEqual([...allocateJointProductionCost('90',outputs)],[['primary','60.0000'],['joint','30.0000']]);
  for(const cost of ['0','0.0001','0.0002','2.3456','999999999999.9999']) {
    const result=allocateJointProductionCost(cost,[...outputs,{itemId:'third',quantity:'3.1415',costWeight:'0.0001'}]);
    assert.equal(toUnits(sum([...result.values()])),toUnits(cost));
    assert([...result.values()].every(value=>toUnits(value)>=0n));
  }
});

test('minimum ledger units and input order cannot change joint output allocation',()=>{
  const outputs=['a','b','c'].map(itemId=>({itemId,quantity:'1',costWeight:'1'}));
  const result=allocateJointProductionCost('0.0001',outputs);
  assert.equal(result.get('a'),'0.0001');assert.equal(result.get('b'),'0.0000');assert.equal(result.get('c'),'0.0000');
  assert.deepEqual([...allocateJointProductionCost('0.0001',[...outputs].reverse())].sort(),[...result].sort());
  for(const invalid of [[outputs[0]!,outputs[0]!],[{itemId:'a',quantity:'0',costWeight:'1'}],[{itemId:'a',quantity:'1',costWeight:'-1'}]])assert.throws(()=>allocateJointProductionCost('1',invalid));
  assert.throws(()=>allocateJointProductionCost('-1',outputs));assert.throws(()=>allocateJointProductionCost('1',[]));
});

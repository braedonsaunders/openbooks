import assert from 'node:assert/strict';
import test from 'node:test';
import {requireDerivedQuantityEvidence} from './derived-quantity.ts';

test('operational quantity retains four-place precision without increasing worked hours',()=>{
  assert.doesNotThrow(()=>requireDerivedQuantityEvidence({kind:'earning',derivedQuantity:'8.1234',derivedRuleCode:'SITE'}));
  assert.doesNotThrow(()=>requireDerivedQuantityEvidence({kind:'earning',hours:'8.25'}));
  assert.throws(()=>requireDerivedQuantityEvidence({kind:'earning',hours:'8.25',derivedQuantity:'8.25',derivedRuleCode:'SITE'}),/no additional worked hours/);
});

test('incomplete, inexact and invalid operational evidence refuses before persistence',()=>{
  for(const derivedQuantity of ['0','-1','8.12345','NaN','Infinity','1e2','100000000000000000000']){
    assert.throws(()=>requireDerivedQuantityEvidence({kind:'earning',derivedQuantity,derivedRuleCode:'SITE'}));
  }
  for(const derivedRuleCode of [undefined,'',' SITE ']){
    assert.throws(()=>requireDerivedQuantityEvidence({kind:'earning',derivedQuantity:'8',derivedRuleCode}));
  }
  assert.throws(()=>requireDerivedQuantityEvidence({kind:'earning',derivedRuleCode:'SITE'}));
  assert.throws(()=>requireDerivedQuantityEvidence({kind:'deduction',derivedQuantity:'8',derivedRuleCode:'SITE'}));
});

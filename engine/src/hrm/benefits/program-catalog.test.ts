import assert from 'node:assert/strict';
import test from 'node:test';
import { benefitsProgramPage } from './list-window.ts';
test('Program lists preserve explicit page boundaries', () => {
  assert.deepEqual(benefitsProgramPage({}),{limit:100,offset:0});
  assert.deepEqual(benefitsProgramPage({limit:2000,offset:1000}),{limit:2000,offset:1000});
  for(const limit of [0,-1,2001,1.5,NaN]) assert.throws(()=>benefitsProgramPage({limit}),/1 to 2000/);
  for(const offset of [-1,0.5,NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>benefitsProgramPage({offset}),/non-negative whole number/);
});

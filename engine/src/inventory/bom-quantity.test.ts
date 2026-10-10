import assert from "node:assert/strict";
import test from "node:test";
import { bomRequiredQuantity, bomQuantityPolicy } from "./bom-scrap.ts";

test("formula ingredients scale from their stated output and round only the final requirement",()=>{
  const policy={quantityBasis:'per_formula' as const,formulaOutputQuantity:'3'};
  const requirement=bomRequiredQuantity('2','1',null,policy);
  assert.equal(requirement.quantity,'0.6667');
  assert.deepEqual(requirement.fraction,{numerator:'2000000000000000000',denominator:'3000000000000000000'});
  assert.equal(bomRequiredQuantity('300','125','2',{quantityBasis:'per_formula',formulaOutputQuantity:'100'}).quantity,'382.5000');
  const tiny=bomRequiredQuantity('0.0001','0.0001',null,{quantityBasis:'per_formula',formulaOutputQuantity:'999999999999999.9999'});
  assert.equal(tiny.quantity,'0.0000');assert.match(tiny.exactQuantity,/^0\.0+[1-9]/,'below-precision ingredients remain visible to the refusal');
});
test("fixed inputs charge once per native batch and keep unit recipes unchanged",()=>{
  for(const output of ['1','100','999.9999']) assert.equal(bomRequiredQuantity(output,'2','5',{quantityBasis:'per_batch'}).quantity,'2.1000');
  assert.equal(bomRequiredQuantity('0','2',null,{quantityBasis:'per_batch'}).quantity,'0.0000');
  assert.deepEqual(bomRequiredQuantity('10','2','5'),{quantity:'21.0000',exactQuantity:'21'});
  assert.throws(()=>bomQuantityPolicy({quantityBasis:'per_batch',formulaOutputQuantity:'100'}),/denominator/);
  for(const denominator of ['0','-1','1e2','1000000000000000','0.00001']) assert.throws(()=>bomQuantityPolicy({quantityBasis:'per_formula',formulaOutputQuantity:denominator}),/positive exact/);
});

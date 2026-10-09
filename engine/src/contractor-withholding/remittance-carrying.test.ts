import assert from "node:assert/strict";
import test from "node:test";
import { allocateWithholdingCarrying, stampPaymentWithholdingCurrency, withholdingCarryingChanged } from "./remittance-carrying.ts";
import { fromUnits,toUnits } from "../money/money.ts";

test('aggregated liability allocation conserves every ledger quantum and is independent of source row order',()=>{
  const rows=[{id:'c',transactionAmount:'1'},{id:'a',transactionAmount:'1'},{id:'b',transactionAmount:'1'}];
  const first=allocateWithholdingCarrying('0.0001',rows),second=allocateWithholdingCarrying('0.0001',[...rows].reverse());
  assert.deepEqual(first,second);
  assert.equal(fromUnits([...first.values()].reduce((total,value)=>total+toUnits(value),0n)),'0.0001');
  assert.ok([...first.values()].every(value=>toUnits(value)>=0n));
});

test('statutory denomination retains the original functional credit without creating a foreign vendor currency exposure',()=>{
  const doc={kind:'vendor_payment',custom:{withholdings:[{liabilityAccountId:'tax',reporting:{currency:'GBP',deducted:'100'}}]}};
  const line={accountId:'tax',amount:'-120.0000',subsidiaryId:'entity',currency:'EUR',txnAmount:'-125.0000',fxRate:'0.96',memo:'Contractor withholding'};
  const stamped=stampPaymentWithholdingCurrency(doc,[line])[0]!;
  assert.deepEqual([stamped.amount,stamped.currency,stamped.txnAmount,stamped.fxRate],['-120.0000','GBP','-100.0000','1.2000000000']);
  assert.deepEqual(line.currency,'EUR');
});

test('zero statutory movement still detects functional or currency carrying differences',()=>{
  const source={accountId:'tax',amount:'150.0000',currency:'GBP',txnAmount:'100.0000',fxRate:'1.5'};
  assert.equal(withholdingCarryingChanged([source,{...source,amount:'-120.0000',txnAmount:'-100.0000',fxRate:'1.2'}]),true);
  assert.equal(withholdingCarryingChanged([source,{...source,amount:'-150.0000',txnAmount:'-100.0000'}]),false);
  assert.equal(withholdingCarryingChanged([source,{...source,amount:'-150.0000',currency:'EUR',txnAmount:'-125.0000',fxRate:'1.2'}]),true);
});

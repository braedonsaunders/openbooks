import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accruedDepreciation,splitDepreciationPlan} from './depreciation-plan.ts';
import {add} from './money.ts';
test('mid-period service splits conserve every four-decimal unit',()=>{const line={startsOn:'2026-07-01',date:'2026-07-31',amount:'1000'};const r=splitDepreciationPlan([line],'2026-07-16');assert.equal(r.accrued,'483.8710');assert.equal(r.remaining[0]!.amount,'516.1290');assert.equal(add(r.accrued,r.remaining[0]!.amount),'1000.0000');assert.equal(r.remaining[0]!.startsOn,'2026-07-16');});
test('service before a transfer and after a transfer is neither duplicated nor dropped',()=>{const line={startsOn:'2026-08-16',date:'2026-08-31',amount:'160'};assert.equal(accruedDepreciation(line,'2026-08-16'),'0.0000');assert.equal(accruedDepreciation(line,'2026-08-21'),'50.0000');assert.equal(accruedDepreciation(line,'2026-09-01'),'160.0000');});

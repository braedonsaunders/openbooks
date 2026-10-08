import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceHistoryHash, validateSourceBatch, type SourceScheduleBatch } from './source-history.ts';

const row = () => ({sourceKey:'7',sourceHash:sourceHistoryHash({date:'2020-01-01',label:'SON/N'}),
  payload:{date:'2020-01-01',label:'SON/N'},disposition:'recorded' as const,boardId:'019f5ea3-44c5-72c0-ad3b-ef34c19c8763',
  workerPartyId:'019f5eeb-04bd-79fe-9971-69305044402c',onDate:'2020-01-01',label:'SON/N',result:null,notes:null,
  visibleInSource:false,linkedEntryId:null,reason:'Retain exact source scheduling evidence.',expectedPriorId:null});
const batch = ():SourceScheduleBatch=>({sourceSystem:'Legacy planning',sourceDataset:'schedule',captureHash:'a'.repeat(64),rows:[row()]});

test('date-only source evidence preserves literal labels without supplying a working span',()=> {
  const input=batch();validateSourceBatch(input);assert.equal(input.rows[0]!.label,'SON/N');
  assert.equal('startsAt' in input.rows[0]!,false);assert.equal('hours' in input.rows[0]!,false);
  assert.equal(input.rows[0]!.visibleInSource,false);
});
test('changed source payload and duplicate source keys refuse before any command',()=> {
  const input=batch();assert.throws(()=>validateSourceBatch({...input,rows:[{...row(),payload:{date:'2020-01-02',label:'SON/N'}}]}),/hash/);
  assert.throws(()=>validateSourceBatch({...input,rows:[row(),row()]}),/once/);
});
test('missing identities require a reviewed exception, and linked evidence needs a native booking',()=> {
  assert.throws(()=>validateSourceBatch({...batch(),rows:[{...row(),workerPartyId:null}]}),/exact board and person/);
  validateSourceBatch({...batch(),rows:[{...row(),disposition:'exception',boardId:null,workerPartyId:null,onDate:null,reason:'Missing source employee identity; retained for review.'}]});
  assert.throws(()=>validateSourceBatch({...batch(),rows:[{...row(),disposition:'linked'}]}),/native booking/);
});

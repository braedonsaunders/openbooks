import assert from 'node:assert/strict';
import test from 'node:test';
import { coerceField } from './coerce.ts';
import { SETUP_ENTITY_BY_KEY } from './registry.ts';
for (const [entity,key] of [['asset-categories','defaultLifeMonths'],['depreciation-book-policies','lifeMonths']]) {
 const field=SETUP_ENTITY_BY_KEY.get(entity!)!.fields.find(field=>field.key===key)!;
 for (const raw of [0,-1,1.5,1_000_000_000,true,[12],{}]) {
  test(`${entity} refuses invalid depreciation life ${JSON.stringify(raw)}`,()=>{assert.ok('error' in coerceField(field,raw));});
 }
 test(`${entity} accepts inherited life and exact valid boundaries`,()=>{
  for (const raw of [null,'',1,'12',12000]) assert.ok(!('error' in coerceField(field,raw)));
 });
}

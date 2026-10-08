import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCopySql, type CloneOptions } from './clone.ts';
import type { TableInfo } from './catalog.ts';

const opts: CloneOptions = {
  productionOrgId: '65fa9dc7-228f-4e19-8bf1-17d52efeb78d', sandboxOrgId: '47df30a3-4fd1-4570-bb67-09641053ee3b',
  seed: '42b3d7dd-9674-4f3c-8d6a-8ba5d2308130', tier: 'full', masked: false,
};
const table = (name: string, columns: string[], fks: Record<string,string> = {}): TableInfo => ({
  name, hasOrgId: true, hasId: true, columns: columns.map(name => ({ name, isUuid: name !== 'cell_color_rules', udtName: name === 'cell_color_rules' ? 'jsonb' : 'uuid', isNullable: false })),
  fks, fkDeleteRules: {}, hardFks: fks, forceRebase: new Set(),
});

test('resource subjects follow native catalog FK rebasing instead of retaining production identities', () => {
  const entries = table('schedule_entries',['id','org_id','equipment_unit_id','resource_location_id'], { equipment_unit_id:'equipment_units',resource_location_id:'locations' });
  const copy = generateCopySql(entries,opts,new Set(['schedule_entries','equipment_units','locations']),new Set(),new Map(),null)!;
  assert.match(copy,/ob_rebase\("equipment_unit_id"/);
  assert.match(copy,/ob_rebase\("resource_location_id"/);
  assert.ok(copy.includes(opts.sandboxOrgId));
});

test('masked board copies clear tenant-authored color values while full copies retain them', () => {
  const boards = table('schedule_boards',['id','org_id','cell_color_rules']);
  const full = generateCopySql(boards,opts,new Set(['schedule_boards']),new Set(),new Map(),null)!;
  const masked = generateCopySql(boards,{ ...opts,masked:true },new Set(['schedule_boards']),new Set(),new Map(),null)!;
  assert.ok(full.includes('"cell_color_rules"'));
  assert.match(masked,/'\[\]'::jsonb/);
  assert.equal(masked.split('"cell_color_rules"').length,2);
});

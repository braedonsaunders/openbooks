import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCopySql, type CloneOptions } from './clone.ts';
import type { TableInfo } from './catalog.ts';
import { EXCLUDE } from './catalog.ts';
import { TENANT_TABLE_POLICIES } from './tenant-table-policies.ts';
import { DEFAULT_POLICIES } from './masking.ts';

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

test('source scheduling history rebases every native reference and removes source identities and prose from masked copies',()=> {
  const records:TableInfo={name:'schedule_source_records',hasOrgId:true,hasId:true,
    columns:['id','org_id','board_id','worker_party_id','subsidiary_id','linked_entry_id','supersedes_id','created_by'].map(name=>({name,isUuid:true,udtName:'uuid',isNullable:name!=='id'&&name!=='org_id'})).concat([
      {name:'source_key',isUuid:false,udtName:'text',isNullable:false},
      {name:'source_payload',isUuid:false,udtName:'jsonb',isNullable:false},
      {name:'label',isUuid:false,udtName:'text',isNullable:true},
    ]),fks:{board_id:'schedule_boards',worker_party_id:'parties',subsidiary_id:'subsidiaries',linked_entry_id:'schedule_entries',supersedes_id:'schedule_source_records',created_by:'users'},
    hardFks:{},fkDeleteRules:{},forceRebase:new Set()};
  const rebase=new Set(['schedule_source_records','schedule_boards','parties','subsidiaries','schedule_entries','users']);
  const policies=new Map([['schedule_source_records',new Map(DEFAULT_POLICIES.filter(p=>p.tableName==='schedule_source_records').map(p=>[p.columnName,p.transform]))]]);
  const full=generateCopySql(records,opts,rebase,new Set(),policies,null)!;
  const masked=generateCopySql(records,{...opts,masked:true},rebase,new Set(),policies,null)!;
  for(const column of ['board_id','worker_party_id','subsidiary_id','linked_entry_id','supersedes_id','created_by']) assert.ok(full.includes(`ob_rebase("${column}"`));
  assert.match(masked,/md5\("source_key"::text\)/);assert.match(masked,/'\{\}'::jsonb/);assert.match(masked,/REDACTED/);
});


test('reviewed issuance is never cloned while native resource contacts rebase identities and mask reasons',()=>{
 for(const name of ['schedule_distributions','schedule_distribution_recipients']){assert.equal(EXCLUDE.has(name),true);assert.equal(TENANT_TABLE_POLICIES[name as keyof typeof TENANT_TABLE_POLICIES],'skip:no-copy');}
 const contacts=table('schedule_resource_recipients',['id','org_id','board_id','equipment_unit_id','resource_location_id','party_id','subsidiary_id','created_by','updated_by'],{board_id:'schedule_boards',equipment_unit_id:'equipment_units',resource_location_id:'locations',party_id:'parties',subsidiary_id:'subsidiaries',created_by:'users',updated_by:'users'});
 contacts.columns.push({name:'reason',isUuid:false,udtName:'text',isNullable:false});
 const rebase=new Set(['schedule_resource_recipients',...Object.values(contacts.fks)]),policies=new Map([['schedule_resource_recipients',new Map(DEFAULT_POLICIES.filter(p=>p.tableName==='schedule_resource_recipients').map(p=>[p.columnName,p.transform]))]]);
 const full=generateCopySql(contacts,opts,rebase,new Set(),policies,null)!,masked=generateCopySql(contacts,{...opts,masked:true},rebase,new Set(),policies,null)!;
 for(const column of Object.keys(contacts.fks))assert.ok(full.includes(`ob_rebase("${column}"`));assert.match(masked,/REDACTED/);
});


test('full and masked board copies clear automatic delivery operator and audience policy without copying issuance history', () => {
  const boards = table('schedule_boards', ['id', 'org_id', 'automatic_delivery_policy']);
  boards.columns.find(column => column.name === 'automatic_delivery_policy')!.isUuid = false;
  boards.columns.find(column => column.name === 'automatic_delivery_policy')!.udtName = 'jsonb';
  for (const masked of [false, true]) {
    const copy = generateCopySql(boards, { ...opts, masked }, new Set(['schedule_boards']), new Set(), new Map(), null)!;
    assert.match(copy, /null::jsonb/);
    assert.equal(copy.split('"automatic_delivery_policy"').length, 2, 'policy occurs in the target list only; source operator/contact JSON is not selected');
    for (const name of ['schedule_distributions', 'schedule_distribution_recipients']) assert.equal(EXCLUDE.has(name), true);
  }
});

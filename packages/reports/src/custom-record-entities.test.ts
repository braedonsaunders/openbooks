import test from 'node:test'
import assert from 'node:assert/strict'
import { customRecordEntities } from './custom-record-entities'
import { compileCustomQuery } from './custom-query'
import { validateCustomQuery } from './validate'

const definition = { id: 'b7ead1bc-a6cf-4059-8ce4-bf39665c276f', key: 'work-order', name: 'Work order', description: null,
  fields: [{ id: 'header', fields: [{ id: 'hours', type: 'number', label: 'Hours' }, { id: "quoted'field", type: 'text' }, { id:'due',type:'date' }] },
    { id:'materials',repeating:true,title:'Materials',fields:[{id:'quantity',type:'number'}]}] }

test('custom types use typed fields, immutable type IDs, org fences and explicit sublist grain', () => {
  const [e, lines] = customRecordEntities(definition)
  assert.ok(e && lines)
  assert.equal(e.key, 'custom:work-order')
  const q = validateCustomQuery({entity:e.key,mode:'summarize',columns:[],measures:[{fn:'sum',column:'field_hours'}]}, {[e.key]:e})
  const c = compileCustomQuery(e,q,'org-one')
  assert.match(c.text,/::numeric/)
  assert.match(c.text,/r.org_id = \$1/)
  assert.ok(c.values.includes(definition.id))
  assert.equal(c.values[0],'org-one')
  assert.match(e.columns.find(c=>c.key==="field_quoted'field")!.expr,/quoted''field/)
  assert.equal(lines.key,'custom:work-order:materials')
  assert.match(lines.from,/WITH ORDINALITY/)
  assert.ok(lines.columns.some(c=>c.key==='line_quantity'))
  assert.ok(!e.columns.some(c=>c.key==='field_quantity'))
})

test('tenant-defined field IDs cannot escape SQL result aliases',()=>{
 const [e]=customRecordEntities({...definition,fields:[{id:'details',fields:[{id:'odd"name',type:'text'}]}]})
 assert.ok(e)
 const c=compileCustomQuery(e,{entity:e.key,columns:['field_odd"name']},'org')
 assert.match(c.text,/AS "field_odd""name"/)
})

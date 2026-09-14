import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAppQuery, type AppQuerySource } from './query-plan'
const source:AppQuerySource={from:'custom_records r',orgColumn:'r.org_id',predicates:["r.type_key = 'work-order'"],columns:[{key:'id',label:'ID',kind:'uuid',expr:'r.id'},{key:'assignee',label:'Assignee',kind:'uuid',expr:"(r.data->>'assignee')::uuid"},{key:'hours',label:'Hours',kind:'number',expr:"(r.data->>'hours')::numeric"}]}
const parties:AppQuerySource={from:'parties r',orgColumn:'r.org_id',predicates:["r.subsidiary_id IN ('visible')"],columns:[{key:'id',label:'ID',kind:'uuid',expr:'r.id'},{key:'name',label:'Name',kind:'text',expr:'r.display_name'}]}
const catalog=new Map([['work-order',source],['parties',parties]])
const plan={from:{type:'work-order',as:'work'},joins:[{type:'parties',as:'person',kind:'left',on:{left:{source:'work',field:'assignee'},right:{source:'person',field:'id'}}}],select:[{source:'work',field:'hours'},{source:'person',field:'name'}],filters:{combinator:'and',rules:[{field:'work.hours',op:'gte',value:'10'}]},limit:20}
test('joins scope every source before joining and bind typed filters',()=>{
 const q=compileAppQuery(plan,catalog,'tenant-a')
 assert.equal((q.text.match(/r.org_id = 'tenant-a'/g)||[]).length,2)
 assert.match(q.text,/LEFT JOIN \(SELECT/)
 assert.match(q.text,/r.subsidiary_id IN \('visible'\)/)
 assert.match(q.text,/"work"\."__org" = "person"\."__org"/)
 assert.ok(q.values.includes('10'))
 assert.equal(q.requestedLimit,20)
})
test('invalid joins, unknown fields, unauthorized sources and SQL-shaped identifiers refuse',()=>{
 assert.throws(()=>compileAppQuery({...plan,from:{type:'work-order',as:'x;drop'}},catalog,'org'))
 assert.throws(()=>compileAppQuery(plan,new Map([['work-order',source]]),'org'),/unavailable/)
 assert.throws(()=>compileAppQuery({...plan,select:[{source:'person',field:'secret'}]},catalog,'org'),/Unknown/)
 assert.throws(()=>compileAppQuery({...plan,joins:[{...plan.joins[0],as:'work'}]},catalog,'org'),/unique/)
 assert.throws(()=>compileAppQuery({...plan,joins:[{...plan.joins[0],on:{left:{source:'work',field:'hours'},right:{source:'person',field:'id'}}}]},catalog,'org'),/matching types/)
 assert.throws(()=>compileAppQuery({...plan,limit:100000},catalog,'org'))
 assert.throws(()=>compileAppQuery({...plan,filters:{combinator:'or',rules:[{field:'person.secret',op:'eq',value:'x'}]}},catalog,'org'))
})

test('missing filter values and unresolved report presets refuse instead of dropping the constraint',()=>{
 assert.throws(()=>compileAppQuery({...plan,filters:{combinator:'and',rules:[{field:'work.hours',op:'gte'}]}},catalog,'org'),/Incomplete/)
 assert.throws(()=>compileAppQuery({...plan,filters:{combinator:'and',rules:[{field:'work.hours',op:'period_preset',value:'current-month'}]}},catalog,'org'),/Incomplete/)
})

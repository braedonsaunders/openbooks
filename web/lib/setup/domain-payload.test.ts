import { SETUP_ENTITY_BY_KEY } from './registry'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setupAggregatePayload, setupDomainPayload } from './domain-payload'
import { setupFieldOptions, setupFieldVisible, setupReferenceSources, type SetupEntity, type SetupField } from './types'
import { BENEFIT_TRANSACTION_POLICY_ENTITY } from './benefit-transaction-policy'
import { BILLING_ENTITIES } from './entities/billing'

const policy = BILLING_ENTITIES.find((entity) => entity.key === 'dunning-policies')!
const values = { name: 'Standard', gracePeriodDays: '3', minBalance: '12.3400', replyTo: '', isActive: true,
  stages: [{ sequence: '1', name: 'Reminder', offsetDays: '7', subjectTemplate: 'Invoice {{invoice}}', bodyTemplate: 'Please arrange payment.', escalate: false }] }

test('policy forms send exact decimals, numeric days and native stage JSON to the domain', () => {
  const payload = setupDomainPayload(policy, values)
  assert.ok(payload.ok)
  assert.equal(payload.body.gracePeriodDays, 3)
  assert.equal(payload.body.minBalance, '12.3400')
  assert.equal(payload.body.replyTo, null)
  assert.deepEqual(payload.body.stages, [{ ...values.stages[0], sequence: 1, offsetDays: 7 }])
})

test('an ambiguous money input refuses with its remedy instead of changing the amount', () => {
  const payload = setupDomainPayload(policy, { ...values, minBalance: '1,234' })
  assert.equal(payload.ok, false)
  if (!payload.ok) assert.match(payload.error, /ambiguous|1\.234|1234/i)
})

test('a malformed reminder stage refuses before a domain request is sent', () => {
  const payload = setupDomainPayload(policy, { ...values, stages: [{ ...values.stages[0], offsetDays: '7.5' }] })
  assert.equal(payload.ok, false)
  if (!payload.ok) assert.match(payload.error, /stages row 1.*offsetDays.*whole number/)
})

test('aggregate updates send only the declared contract and use the server revision', () => {
  const entity: SetupEntity = { ...policy, mutationPath: '/api/policies', mutationCreateKeys: ['name', 'stages'], mutationUpdateKeys: ['name', 'expectedRevision'], mutationRevision: { requestKey: 'expectedRevision', rowColumn: 'revision' } }
  const form = { name: 'Updated', id: 'spoofed', orgId: 'spoofed', expectedRevision: 999, stages: [] }
  assert.deepEqual(setupAggregatePayload(entity, form, { revision: 7 }), { ok: true, body: { name: 'Updated', expectedRevision: 7 } })
  assert.deepEqual(setupAggregatePayload(entity, form, null), { ok: true, body: { name: 'Updated', stages: [] } })
  assert.deepEqual(setupAggregatePayload(policy, form, { revision: 7 }), { ok: true, body: form })
  for (const revision of [undefined, null, '7', 0, -1, 1.5]) assert.deepEqual(setupAggregatePayload(entity, form, { revision }), { ok: false, error: 'revision' })
  assert.deepEqual(setupDomainPayload(entity, { name: 'Updated', stages: [{ offsetDays: 'invalid locked history' }] }, 'update'), { ok: true, body: { name: 'Updated' } })
})

test('native reference catalogs include nested structured controls without duplicate sources', () => {
  const entity: SetupEntity = { ...policy, fields: [{ key: 'rules', kind: 'objectArray', fields: [{ key: 'componentId', kind: 'ref', ref: 'pay-components' }, { key: 'condition', kind: 'object', fields: [{ key: 'componentId', kind: 'ref', ref: 'pay-components' }, { key: 'employmentId', kind: 'ref', ref: 'worker-employments' }] }] }] }
  assert.deepEqual(setupReferenceSources(entity), ['pay-components', 'worker-employments'])
})

test('structured conditions distinguish constant booleans from employee and numeric values', () => {
  const field: SetupField = { key: 'value', kind: 'boolean', showWhen: { all: [{ field: 'source', in: ['constant'] }, { field: 'type.kind', in: ['boolean'] }] } }
  assert.equal(setupFieldVisible(field, { source: 'constant', type: { kind: 'boolean' } }), true)
  for (const source of ['assignment', 'period_gross', undefined]) assert.equal(setupFieldVisible(field, { source, type: { kind: 'boolean' } }), false)
  for (const type of [{ kind: 'money' }, {}, null]) assert.equal(setupFieldVisible(field, { source: 'constant', type }), false)
  assert.equal(setupFieldVisible({ ...field, hidden: true }, { source: 'constant', type: { kind: 'boolean' } }), false)
  const options = [{ value: 'constant' }]
  assert.deepEqual(setupFieldOptions({ key: 'source', kind: 'select', scopedOptions: { scopeField: 'type.kind', byValue: { boolean: options } } }, { type: { kind: 'boolean' } }), options)
})

test('structured discriminants remove only explicitly inapplicable keys, preserving native evidence', () => {
  const entity: SetupEntity = { ...policy, fields: [{ key: 'type', kind: 'object', fields: [{ key: 'kind', kind: 'select', options: [{ value: 'scalar' }, { value: 'money' }] }, { key: 'currency', kind: 'text', omitWhenHidden: true, showWhen: { field: 'kind', in: ['money'] } }] }] }
  assert.deepEqual(setupDomainPayload(entity, { type: { kind: 'scalar', currency: 'CAD', evidence: 'retained' } }), { ok: true, body: { type: { kind: 'scalar', evidence: 'retained' } } })
  assert.deepEqual(setupDomainPayload(entity, { type: { kind: 'money', currency: 'CAD', evidence: 'retained' } }), { ok: true, body: { type: { kind: 'money', currency: 'CAD', evidence: 'retained' } } })
})


test('transaction rules retain exact shares, use live position choices and clear an inapplicable ceiling', () => {
  const groupId='10000000-0000-4000-8000-000000000001', employmentId='10000000-0000-4000-8000-000000000002';
  const values={documentKind:'sales_order',dateBasis:'document_date',groupingSegmentId:'',itemIds:[groupId],positions:[{key:'lead',name:'Lead',weight:'2.0000'}],responsibilities:[{groupId,positionKey:'lead',employmentId,effectiveFrom:'2026-01-01',effectiveTo:''}],limits:[{groupId,kind:'none',amount:'1,234'}],reason:'Record policy'};
  const payload=setupDomainPayload(BENEFIT_TRANSACTION_POLICY_ENTITY,values,'update'); assert.ok(payload.ok);
  assert.deepEqual(payload.body.limits,[{groupId,kind:'none',amount:null}]);
  assert.deepEqual(payload.body.responsibilities,[{...values.responsibilities[0],effectiveTo:null}]);
  const field=BENEFIT_TRANSACTION_POLICY_ENTITY.fields.find(field=>field.key==='responsibilities')!.fields!.find(field=>field.key==='positionKey')!;
  assert.deepEqual(setupFieldOptions(field,values.responsibilities[0]!,values),[{value:'lead',label:'Lead'}]);
  assert.equal(setupDomainPayload(BENEFIT_TRANSACTION_POLICY_ENTITY,{...values,responsibilities:[{...values.responsibilities[0],positionKey:'unknown'}]},'update').ok,false);
});


test('structured delivery controls retain parent board scope while coercing sibling audience conditions', () => {
  const board = SETUP_ENTITY_BY_KEY.get('schedule-boards')!;
  const policyField = board.fields.find(field => field.key === 'automaticDeliveryPolicy')!;
  const entity = { ...board, fields: [policyField] };
  const raw = { operatorId: '00000000-0000-4000-8000-000000000001', timeZone: 'America/Toronto', days: 14, anchor: 'week', weekStartsOn: 0, visibility: 'board', recipientMode: 'automatic', cohort: 'scope', subjectIds: [], additionalPartyIds: [], additionalRoleKeys: [], includePdf: true };
  const resource = setupDomainPayload(entity, { rowKind: 'resources', automaticDeliveryPolicy: raw });
  assert.equal(resource.ok, true);
  if (!resource.ok) throw new Error(resource.error);
  assert.equal((resource.body.automaticDeliveryPolicy as Record<string, unknown>).cohort, undefined);
  const people = setupDomainPayload(entity, { rowKind: 'people', automaticDeliveryPolicy: raw });
  assert.equal(people.ok, true);
  if (!people.ok) throw new Error(people.error);
  assert.equal((people.body.automaticDeliveryPolicy as Record<string, unknown>).cohort, 'scope');
});

import assert from 'node:assert/strict'
import test from 'node:test'
import { setupAggregatePayload, setupDomainPayload } from './domain-payload'
import { setupFieldOptions, setupFieldVisible, setupReferenceSources, type SetupEntity, type SetupField } from './types'
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

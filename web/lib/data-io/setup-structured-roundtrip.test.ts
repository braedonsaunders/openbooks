import assert from 'node:assert/strict'
import test from 'node:test'
import { SETUP_ENTITY_BY_KEY } from '../setup/registry'
import { buildRow, coerceField, decodeStructuredSetupValues } from '../setup/coerce'
import { validateEntityIntegrity } from '../setup/write'
import { exportCell } from './resource-core'

const noDatabase = { execute: async () => { throw new Error('These configuration shapes require no database lookup') } } as never

const cases = [
  { entity: 'hrm-interviewer-pools', key: 'availability', value: [{ startsAt: '2026-10-01T09:00:00.123456-04:00', endsAt: '2026-10-01T10:00:00-04:00', timezone: 'America/Toronto', evidence: { source: 'declared' } }], other: { name: 'Interview panel' } },
  { entity: 'hrm-offer-templates', key: 'clauses', value: [{ key: 'notice', label: 'Notice', body: 'Two weeks\nWritten notice', default_on: false, evidence: 'retained' }], other: { name: 'Offer', bodyTemplate: 'Offer content' } },
  { entity: 'hrm-retention-rules', key: 'regionScope', value: { applies_to: 'countries', countries: ['CA', 'US'], evidence: 'retained' }, other: { name: 'Retention', basis: 'inactivity', retainMonths: 24, action: 'anonymize' } },
] as const

for (const scenario of cases) {
  test(`${scenario.entity} exports and reimports through shared coercion and real native integrity validation`, async () => {
    const entity = SETUP_ENTITY_BY_KEY.get(scenario.entity)!
    const field = entity.fields.find((entry) => entry.key === scenario.key)!
    const cell = await exportCell({ key: field.key, label: field.key, kind: 'long_text' }, scenario.value, {} as never)
    assert.equal(typeof cell, 'string')
    const original: Record<string, unknown> = { ...scenario.other, [field.key]: cell }
    const decoded = decodeStructuredSetupValues(entity, original)
    assert.ok('body' in decoded)
    assert.deepEqual(decoded.body[field.key], scenario.value)
    assert.equal(original[field.key], cell, 'the transfer snapshot remains immutable')
    assert.equal(await validateEntityIntegrity(entity, decoded.body, 'org', undefined, noDatabase), null)
    const native = buildRow(entity, decoded.body, { forCreate: true })
    assert.ok('cols' in native)
    const bound = native.cols.find((column) => column.column === coerceColumn(field.key))!
    assert.equal(typeof bound.value, 'string', 'JSONB uses one exact driver text parameter')
    assert.deepEqual(JSON.parse(String(bound.value)), scenario.value)
  })
}

function coerceColumn(key: string): string {
  const field = { key, kind: 'text' } as const
  const result = coerceField(field, '')
  assert.ok('column' in result)
  return result.column
}

test('malformed structured transfers refuse by name without acquiring a write or substituting defaults', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-interviewer-pools')!
  for (const availability of ['{broken', '{}', '[null]', '[{"startsAt":"2026-10-01T09:00:00"}]']) {
    const decoded = decodeStructuredSetupValues(entity, { name: 'Pool', availability })
    assert.ok('error' in decoded)
    assert.match(decoded.error, /availability/)
    assert.ok(!('body' in decoded))
  }
  assert.deepEqual(decodeStructuredSetupValues(entity, { name: 'Unchanged' }), { body: { name: 'Unchanged' } })
})

test('shape-valid but unordered windows reach the real engine refusal with its remedy', async () => {
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-interviewer-pools')!
  const windows = [{ startsAt: '2026-10-01T10:00:00-04:00', endsAt: '2026-10-01T09:00:00-04:00', timezone: 'America/Toronto' }]
  const decoded = decodeStructuredSetupValues(entity, { name: 'Pool', availability: JSON.stringify(windows) })
  assert.ok('body' in decoded)
  assert.match(await validateEntityIntegrity(entity, decoded.body, 'org', undefined, noDatabase) ?? '', /ends before it starts.*declare an ordered window/)
})

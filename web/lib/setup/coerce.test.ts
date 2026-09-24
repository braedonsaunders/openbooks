import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRow, coerceField, describeDbError } from './coerce.ts'
import { foldWholeNumber } from './whole-number'
import { SETUP_ENTITY_BY_KEY, type SetupField } from './registry.ts'

const countryField: SetupField = { key: 'country', kind: 'country' }

test('setup country fields normalize and validate against the ISO country list', () => {
  assert.deepEqual(coerceField(countryField, ' ca '), { column: 'country', value: 'CA' })
  assert.deepEqual(coerceField(countryField, ''), { column: 'country', value: null })
  assert.deepEqual(coerceField(countryField, 'AA'), { error: 'country must be a valid ISO country code' })
})

test('setup JSON fields parse objects without accepting malformed input', () => {
  const field: SetupField = { key: 'taxAttributes', kind: 'json' }
  assert.deepEqual(coerceField(field, '{"us_macrs_class":"gds_5"}'), {
    column: 'tax_attributes',
    value: { us_macrs_class: 'gds_5' },
  })
  assert.deepEqual(coerceField(field, '{broken'), { error: 'taxAttributes must be valid JSON' })
  assert.deepEqual(coerceField(field, 'hello'), { error: 'taxAttributes must be valid JSON' })
})

test('setup string-array fields bind jsonb-safe JSON strings and keep empty-means-everyone', () => {
  const field: SetupField = { key: 'includedJobTitles', kind: 'stringArray', ref: 'job-titles' }
  // The drawer sends a real array; the bound value is a JSON STRING (a JS
  // array would be rendered as a Postgres array literal — invalid jsonb).
  assert.deepEqual(coerceField(field, ['Supervisor', 'Quality Coordinator']), {
    column: 'included_job_titles',
    value: '["Supervisor","Quality Coordinator"]',
  })
  // Case/whitespace duplicates collapse to the first spelling; blanks drop.
  assert.deepEqual(coerceField(field, [' Project  Manager ', 'project manager', '  ']), {
    column: 'included_job_titles',
    value: '["Project Manager"]',
  })
  // Imports may send the JSON-encoded form.
  assert.deepEqual(coerceField(field, '["Foreman"]'), {
    column: 'included_job_titles',
    value: '["Foreman"]',
  })
  // Empty stays [] — for the rule engine an empty list means everyone.
  assert.deepEqual(coerceField(field, []), { column: 'included_job_titles', value: '[]' })
  assert.deepEqual(coerceField(field, ''), { column: 'included_job_titles', value: '[]' })
  assert.deepEqual(coerceField(field, undefined), { column: 'included_job_titles', value: '[]' })
  // Non-string members and malformed JSON are rejected, not coerced.
  assert.deepEqual(coerceField(field, [1, 2]), {
    error: 'includedJobTitles must be a list of text values',
  })
  assert.deepEqual(coerceField(field, '{broken'), {
    error: 'includedJobTitles must be a list of text values',
  })
  assert.deepEqual(coerceField(field, '{"not":"a list"}'), {
    error: 'includedJobTitles must be a list of text values',
  })
})

test('setup decimal and percent fields canonicalize without crossing IEEE-754', () => {
  const rate: SetupField = { key: 'ratePercent', kind: 'percent', required: true }
  const money: SetupField = { key: 'acquisitionCost', kind: 'decimal', required: true }
  assert.deepEqual(coerceField(rate, '13.2500'), { column: 'rate_percent', value: '13.2500000000' })
  assert.deepEqual(coerceField(rate, 13.25), { column: 'rate_percent', value: '13.2500000000' })
  assert.deepEqual(coerceField(money, '00100.1000'), { column: 'acquisition_cost', value: '100.1000000000' })
  assert.deepEqual(coerceField({ key: 'acquisitionRate', kind: 'decimal', required: true }, '1.25'), {
    column: 'acquisition_rate',
    value: '1.2500000000',
  })
  assert.deepEqual(coerceField(rate, '1e-2'), { error: 'ratePercent must be a number' })
  assert.deepEqual(coerceField(rate, '0.30000000000000004'), { error: 'ratePercent must be a number' })
  assert.deepEqual(coerceField(money, 'not-a-number'), { error: 'acquisitionCost must be a number' })
})

test('number-sequence record choices store stable kind tokens without requiring UUIDs', () => {
  const field: SetupField = {
    key: 'documentKind',
    kind: 'ref',
    ref: 'number-sequence-kinds',
    required: true,
  }
  assert.deepEqual(coerceField(field, 'customer_invoice'), {
    column: 'document_kind',
    value: 'customer_invoice',
  })
  assert.deepEqual(coerceField(field, 'custrec:sales-order-test'), {
    column: 'document_kind',
    value: 'custrec:sales-order-test',
  })
})

test('earning creation applies its declared defaults while explicit false remains authoritative', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('pay-components')!
  const body = { code: 'TEST', name: 'Test earning', kind: 'earning', value: '10' }
  const built = buildRow(entity, body, { forCreate: true })
  assert.ok('cols' in built)
  const values = Object.fromEntries(built.cols.map(({ column, value }) => [column, value]))
  for (const column of ['taxable', 'pensionable', 'insurable', 'vacationable', 'include_in_disposable_earnings']) assert.equal(values[column], true)
  assert.equal(values.basis, 'fixed_amount')
  assert.equal(values.protection_priority, 100)
  const explicit = buildRow(entity, { ...body, taxable: false, pensionable: 'no' }, { forCreate: true })
  assert.ok('cols' in explicit)
  assert.equal(explicit.cols.find(entry => entry.column === 'taxable')!.value, false)
  assert.equal(explicit.cols.find(entry => entry.column === 'pensionable')!.value, false)
})

test('number-sequence creation uses declared numeric defaults without masking invalid explicit values', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('number-sequences')!
  const built = buildRow(entity, { documentKind: 'journal' }, { forCreate: true })
  assert.ok('cols' in built)
  assert.equal(built.cols.find(entry => entry.column === 'next_number')!.value, 1)
  assert.equal(built.cols.find(entry => entry.column === 'padding')!.value, 5)
  assert.deepEqual(buildRow(entity, { documentKind: 'journal', nextNumber: 'invalid' }, { forCreate: true }), { error: 'nextNumber must be a whole number' })
})

test('setup updates distinguish omitted boolean controls from explicit changes', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('pay-components')!
  const built = buildRow(entity, { name: 'Metadata update', kind: 'earning', taxable: false, nonPeriodic: true }, { forCreate: false })
  assert.ok('cols' in built)
  assert.equal(built.cols.find(entry => entry.column === 'taxable')!.value, false)
  assert.equal(built.cols.find(entry => entry.column === 'non_periodic')!.value, true)
  for (const column of ['pensionable', 'insurable', 'vacationable', 'is_active', 'include_in_disposable_earnings']) assert.ok(!built.cols.some(entry => entry.column === column))
})

test('setup date fields reject impossible calendar dates, not just malformed shapes', () => {
  const field: SetupField = { key: 'effectiveFrom', kind: 'date' }
  assert.deepEqual(coerceField(field, '2024-02-29'), { column: 'effective_from', value: '2024-02-29' })
  assert.deepEqual(coerceField(field, '2024-01-31'), { column: 'effective_from', value: '2024-01-31' })
  for (const bad of ['2023-02-29', '2024-02-30', '2024-04-31', '2024-13-01', '2024-00-10', '0000-01-01', 'not-a-date', '2024-1-1']) {
    assert.deepEqual(coerceField(field, bad), { error: 'effectiveFrom must be a date' })
  }
})

test('blank keepDefault fields fall through to database defaults instead of refusing (F-t06-022)', () => {
  // keepDefault columns are NOT NULL WITH a database default: the drawer
  // sends explicit empty strings for untouched inputs, and the server must
  // omit them (buildRow drops null/undefined) rather than refuse with a
  // camelCase "X is required" the dialog then echoes.
  const rate: SetupField = { key: 'acquisitionRate', kind: 'decimal', required: true, keepDefault: true }
  assert.deepEqual(coerceField(rate, ''), { column: 'acquisition_rate', value: null })
  assert.deepEqual(coerceField(rate, undefined), { column: 'acquisition_rate', value: null })
  const nci: SetupField = {
    key: 'nciMeasurement', kind: 'select', required: true, keepDefault: true,
    options: [{ value: 'proportionate', labelKey: 'options.nciMeasurement.proportionate' }],
  }
  assert.deepEqual(coerceField(nci, ''), { column: 'nci_measurement', value: undefined })
  // Explicit keepDefault values still bind exactly.
  assert.deepEqual(coerceField(rate, '1.37'), { column: 'acquisition_rate', value: '1.3700000000' })
  assert.deepEqual(coerceField(nci, 'proportionate'), { column: 'nci_measurement', value: 'proportionate' })
  // Non-keepDefault required blanks still refuse — the exemption is narrow.
  assert.deepEqual(coerceField({ key: 'ownershipPercent', kind: 'percent', required: true }, ''), {
    error: 'ownershipPercent is required',
  })
})

test('database errors never echo SQL text to the client (F-t06-022)', () => {
  // Drizzle wraps driver failures with the full SQL + params in its own
  // message; only the driver's cause text (plain Postgres, e.g. a trigger's
  // user-language refusal) may surface.
  const refusal = Object.assign(new Error('full consolidation requires goodwill and fair-value adjustment accounts'), { code: 'P0001' })
  const wrapper = Object.assign(
    new Error('Failed query: insert into subsidiary_ownership_interests (org_id) values ($1)\nparams: 00000000-0000-0000-0000-000000000000'),
    { query: 'insert into subsidiary_ownership_interests (org_id) values ($1)', params: ['00000000-0000-0000-0000-000000000000'], cause: refusal },
  )
  assert.equal(describeDbError(wrapper), 'full consolidation requires goodwill and fair-value adjustment accounts')
  // A wrapper with no driver message degrades to generic, never SQL.
  const bare = Object.assign(new Error('Failed query: insert into t values (1)'), { query: 'insert into t values (1)' })
  assert.equal(describeDbError(bare), 'save failed')
  // Mapped constraint codes and plain non-driver errors keep prior behavior.
  assert.equal(describeDbError(Object.assign(new Error('x'), { code: '23505' })), 'duplicate')
  assert.equal(describeDbError(new Error('boom')), 'boom')
})

test('whole-number slots fold strict spellings and ride the rest through', () => {
  // F9: the setup text inputs send integers as strings. Clean crossings
  // become numbers ('-1' crosses too — the negativity refusal fires after
  // the fold); blanks ride absent (the caller nulls an optional field);
  // '1.5' and 'abc' ride through untouched so the shape refusal fires on
  // the original value with the field's own words.
  for (const value of ['30', ' 30 ', 30, 0, '0', '-1']) assert.equal(foldWholeNumber(value), Number(value))
  for (const value of [undefined, null, '', '   ']) assert.equal(foldWholeNumber(value), undefined)
  for (const value of ['1.5', 'abc', '30 days', 'NaN', 1.5, true]) assert.equal(foldWholeNumber(value), value)
  assert.deepEqual(foldWholeNumber({}), {})
  assert.equal(foldWholeNumber([]), 0, 'String([]) is blank, and blank numbers as zero — same Number() spellings the leave fold always accepted')
  assert.ok(Number.isNaN(foldWholeNumber(NaN) as number))
})

test('setup booleans accept documented scalar spellings and reject malformed controls', () => {
  const field: SetupField = { key: 'taxable', kind: 'boolean' }
  for (const value of [true, 1, 'true', ' YES ', 'y', '1', 't']) assert.deepEqual(coerceField(field, value), { column: 'taxable', value: true })
  for (const value of [false, 0, 'false', ' NO ', 'n', '0', 'f', '', ' ', null, undefined]) assert.deepEqual(coerceField(field, value), { column: 'taxable', value: false })
  for (const value of ['false-ish', 'truthy', 2, -1, 0.5, NaN, Infinity, [], ['yes'], { enabled: true }]) assert.deepEqual(coerceField(field, value), { error: 'taxable must be a boolean' })
})

test('worker-comp group rates refuse negatives through the declared field (B-PRJ-09)', () => {
  // A worker-comp rate prices into every affected cost rate, so a negative
  // rate must refuse at the write boundary — the generic percent coercion
  // admits negatives unless the field declares min. The costing read path
  // refuses negative group rates by name as well, for rows around this rule.
  const entity = SETUP_ENTITY_BY_KEY.get('worker-comp-groups')
  assert.ok(entity)
  const field = entity.fields.find((f) => f.key === 'ratePercent')
  assert.ok(field)
  assert.deepEqual(coerceField(field, -2.5), { error: 'ratePercent must be at least 0' })
  const ok = coerceField(field, 5)
  assert.ok('column' in ok && ok.column === 'rate_percent')
})

test('refs to natural-key entities carry the key, never a UUID (hrm-document-categories)', () => {
  // Templates and retention schedules store the category KEY, and the generic
  // picker offers it via refValue — so the writer must accept what the picker
  // offered. Before refValue, a key like 'offer-letter' died here with
  // 'categoryKey must reference a valid record' and never reached the
  // write path's declared-category refusal.
  const field: SetupField = { key: 'categoryKey', kind: 'ref', ref: 'hrm-document-categories' }
  assert.deepEqual(coerceField(field, 'offer-letter'), { column: 'category_key', value: 'offer-letter' })
  // UUID-shaped refs to ordinary entities still validate as UUIDs.
  const uuidField: SetupField = { key: 'levelId', kind: 'ref', ref: 'hrm-job-levels' }
  assert.deepEqual(coerceField(uuidField, 'not-a-uuid'), { error: 'levelId must reference a valid record' })
})

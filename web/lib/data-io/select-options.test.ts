import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchSelectOption,
  selectAllowedValues,
  selectRefusal,
} from './select-options.ts'

const KIND = [
  { value: 'company', label: 'Company' },
  { value: 'person', label: 'Person' },
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'employee', label: 'Employee' },
]

test('select matching accepts the canonical value exactly', () => {
  assert.equal(matchSelectOption(KIND, 'company'), 'company')
})

test('select matching accepts canonical values and displayed labels case-insensitively', () => {
  assert.equal(matchSelectOption(KIND, 'Company'), 'company')
  assert.equal(matchSelectOption(KIND, 'COMPANY'), 'company')
  assert.equal(matchSelectOption(KIND, '  customer  '), 'customer')
  assert.equal(matchSelectOption(KIND, 'Vendor'), 'vendor')
})

test('select matching accepts localized labels through aliases', () => {
  const withAliases = [...KIND, { value: 'company', label: 'Unternehmen' }]
  assert.equal(matchSelectOption(withAliases, 'unternehmen'), 'company')
})

test('select matching tolerates separators only when unambiguous', () => {
  const frequency = [
    { value: 'one_time', label: 'one_time' },
    { value: 'monthly', label: 'monthly' },
  ]
  assert.equal(matchSelectOption(frequency, 'One time'), 'one_time')
  assert.equal(matchSelectOption(frequency, 'ONE-TIME'), 'one_time')
})

test('select matching refuses blanks, unknown values, and ambiguous cells', () => {
  assert.equal(matchSelectOption(KIND, ''), null)
  assert.equal(matchSelectOption(KIND, '   '), null)
  assert.equal(matchSelectOption(KIND, 'Partner'), null)
  const ambiguous = [
    { value: 'a-b', label: 'a-b' },
    { value: 'a_b', label: 'a_b' },
  ]
  assert.equal(matchSelectOption(ambiguous, 'a b'), null)
})

test('select refusal names the field, quotes the input, and lists the allowed values', () => {
  assert.equal(
    selectRefusal('kind', 'Company', [{ value: 'company', label: 'company' }]),
    'kind: invalid value "Company" — use one of: company',
  )
  assert.deepEqual(selectAllowedValues(KIND), ['company', 'person', 'customer', 'vendor', 'employee'])
})

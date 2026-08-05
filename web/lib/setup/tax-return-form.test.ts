import test from 'node:test'
import assert from 'node:assert/strict'
import {
  governmentFormatForSubmissionChannel,
  normalizeTaxReturnFormInput,
} from './tax-return-form.ts'

test('each filing method derives its only compatible government format', () => {
  assert.equal(governmentFormatForSubmissionChannel('print_pdf'), 'paper')
  assert.equal(governmentFormatForSubmissionChannel('file_upload'), 'certified_file')
  assert.equal(governmentFormatForSubmissionChannel('efile_api'), 'api')
  assert.equal(governmentFormatForSubmissionChannel('portal_manual'), 'portal_entry')
  assert.equal(governmentFormatForSubmissionChannel('unknown'), undefined)
})

test('tax return input replaces a contradictory government format', () => {
  assert.deepEqual(
    normalizeTaxReturnFormInput('tax-return-forms', {
      submissionChannel: 'file_upload',
      governmentFormat: 'portal_entry',
    }),
    {
      submissionChannel: 'file_upload',
      governmentFormat: 'certified_file',
    },
  )

  const other = { submissionChannel: 'file_upload' }
  assert.equal(normalizeTaxReturnFormInput('tax-codes', other), other)

  assert.deepEqual(
    normalizeTaxReturnFormInput('tax-return-forms', { governmentFormat: 'paper' }),
    {},
  )
})

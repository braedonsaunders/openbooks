import assert from 'node:assert/strict'
import test from 'node:test'
import { requestedExportFormat } from './types.ts'

test('export format defaults only when absent and refuses supplied unknown values', () => {
  assert.equal(requestedExportFormat(undefined), 'csv')
  assert.equal(requestedExportFormat('csv'), 'csv')
  assert.equal(requestedExportFormat('xlsx'), 'xlsx')
  assert.equal(requestedExportFormat('json'), 'json')
  assert.equal(requestedExportFormat('pdf'), null)
  assert.equal(requestedExportFormat(null), null)
  assert.equal(requestedExportFormat('CSV'), null)
})

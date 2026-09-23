import assert from 'node:assert/strict'
import test from 'node:test'
import { filenameFromDisposition } from './export-download'

// UX-16b: the download must carry the server's filename so completion can
// name the real file. Disposition parsing covers the shapes the export routes
// emit (quoted, RFC 5987 starred, bare) and falls back otherwise.
test('a quoted filename wins', () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="aging-2026-09-23.csv"', 'report.csv'),
    'aging-2026-09-23.csv',
  )
})

test('an RFC 5987 starred filename is decoded', () => {
  assert.equal(
    filenameFromDisposition(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      'report.pdf',
    ),
    'résumé.pdf',
  )
})

test('a bare filename is used when nothing else matches', () => {
  assert.equal(filenameFromDisposition('attachment; filename=ledger.xlsx', 'report.xlsx'), 'ledger.xlsx')
})

test('a missing disposition falls back', () => {
  assert.equal(filenameFromDisposition(null, 'report.csv'), 'report.csv')
  assert.equal(filenameFromDisposition('', 'report.csv'), 'report.csv')
})

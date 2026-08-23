import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./file-audit.ts', import.meta.url), 'utf8')

test('recordFileEvent persists audit evidence and does not swallow insert failures', () => {
  const start = source.indexOf('export async function recordFileEvent')
  const end = source.indexOf('export type FileActivityEntry', start)
  assert.ok(start >= 0 && end > start, 'recordFileEvent is defined')
  const fn = source.slice(start, end)

  assert.match(fn, /await db\.execute\(sql`/)
  assert.doesNotMatch(fn, /best-effort/)
  assert.doesNotMatch(fn, /\bcatch\b/)
})

test('file audit contract matches transaction audit fail-closed persistence', () => {
  const transactionAudit = readFileSync(
    new URL('../../engine/src/transaction-audit.ts', import.meta.url),
    'utf8',
  )
  const recordStart = transactionAudit.indexOf('export async function recordTransactionAudit')
  const recordEnd = transactionAudit.indexOf('\n}', recordStart)
  const recordFn = transactionAudit.slice(recordStart, recordEnd + 2)

  assert.match(recordFn, /await runner\.execute\(sql`/)
  assert.doesNotMatch(recordFn, /\bcatch\b/)

  assert.match(source, /Audit evidence is required/)
})

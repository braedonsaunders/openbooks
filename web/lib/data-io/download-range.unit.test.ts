import assert from 'node:assert/strict'
import test from 'node:test'
import { transferDownloadRange } from './download-range'

test('byte ranges preserve exact boundaries for resumed and suffix downloads', () => {
  assert.equal(transferDownloadRange(null, 10), null)
  assert.deepEqual(transferDownloadRange('bytes=4-7', 10), { start: 4, end: 7 })
  assert.deepEqual(transferDownloadRange('bytes=4-', 10), { start: 4, end: 9 })
  assert.deepEqual(transferDownloadRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(transferDownloadRange('bytes=0-99', 10), { start: 0, end: 9 })
  assert.deepEqual(transferDownloadRange('bytes=-99', 10), { start: 0, end: 9 })
})
test('invalid, unsafe or multiple ranges refuse with a usable remedy', () => {
  for (const range of ['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=7-4', 'bytes=0-1,4-5', 'bytes=9007199254740993-', 'items=0-2']) {
    assert.throws(() => transferDownloadRange(range, 10), /range is unavailable.*restart this export download/)
  }
})

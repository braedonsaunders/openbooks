import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QUEUE_SEGMENTS,
  QUEUE_SEGMENT_STATUS,
  resolveQueueStatus,
  segmentOfServiceStatus,
} from './queue-status'

// The queue's status segments are a pure mapping with a refusal for unknown
// input: an unrecognized `status` param must name the valid segments, never
// silently list everything while the URL promises a filter.
test('absent status means All with no service filter', () => {
  for (const raw of [undefined, null, '']) {
    const resolved = resolveQueueStatus(raw)
    assert.equal(resolved.ok, true)
    if (resolved.ok) {
      assert.equal(resolved.segment, null)
      assert.equal(resolved.serviceStatus, null)
    }
  }
})

test('each of the five segments resolves to its service state', () => {
  assert.deepEqual([...QUEUE_SEGMENTS], ['draft', 'submitted', 'approved', 'rejected', 'withdrawn'])
  assert.equal(QUEUE_SEGMENT_STATUS.submitted, 'pending_approval')
  for (const segment of QUEUE_SEGMENTS) {
    const resolved = resolveQueueStatus(segment)
    assert.equal(resolved.ok, true)
    if (resolved.ok) {
      assert.equal(resolved.segment, segment)
      assert.equal(resolved.serviceStatus, QUEUE_SEGMENT_STATUS[segment])
    }
  }
})

test('an unknown segment is a refusal naming the valid segments', () => {
  const resolved = resolveQueueStatus('pending_approval')
  assert.equal(resolved.ok, false)
  if (!resolved.ok) {
    assert.equal(resolved.refusal.code, 'UNKNOWN_QUEUE_STATUS')
    // The message names the offending value and every valid segment: the
    // message is the entire product of this refusal.
    assert.match(resolved.refusal.message, /"pending_approval"/)
    for (const segment of QUEUE_SEGMENTS) {
      assert.match(resolved.refusal.message, new RegExp(segment), `refusal names ${segment}`)
    }
  }
})

test('applied counts toward no segment and lists under All only', () => {
  assert.equal(segmentOfServiceStatus('applied'), null)
  for (const segment of QUEUE_SEGMENTS) {
    assert.equal(segmentOfServiceStatus(QUEUE_SEGMENT_STATUS[segment]), segment)
  }
})

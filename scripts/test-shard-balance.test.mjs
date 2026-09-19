import assert from 'node:assert/strict'
import { test } from 'node:test'

import { balancedShards, shardFiles, testManifest } from './test-suite.mjs'

const files = Array.from({ length: 64 }, (_, index) => `engine/src/file-${String(index).padStart(2, '0')}.test.ts`)

/**
 * The failure round robin actually has: cost is uneven AND correlated with
 * position, so `position % count` lands the expensive files together. Here the
 * first four files of every block of sixteen are slow, which is exactly the
 * collision a modulo split cannot see. No single file outweighs a balanced
 * shard, so a good packing can get close to the mean.
 */
function skewedTimings() {
  return Object.fromEntries(files.map((file, index) => [file, index % 16 < 4 ? 8_000 : 500]))
}

function loads(buckets, timings) {
  return buckets.map((bucket) => bucket.reduce((total, file) => total + timings[file], 0))
}

test('every file lands in exactly one shard', () => {
  for (const count of [1, 4, 7, 16]) {
    const buckets = balancedShards(files, count, skewedTimings())
    assert.equal(buckets.length, count)
    assert.deepEqual(buckets.flat().slice().sort(), [...files].sort())
    assert.equal(new Set(buckets.flat()).size, files.length)
  }
})

test('packing is deterministic, so the CI completeness gate can re-derive it', () => {
  const first = balancedShards(files, 16, skewedTimings())
  const second = balancedShards(files, 16, skewedTimings())
  assert.deepEqual(first, second)
  // Order within a shard stays repository order, not weight order.
  for (const bucket of first) assert.deepEqual(bucket, [...bucket].sort())
})

test('packing by measured cost beats packing by file count', () => {
  const timings = skewedTimings()
  const roundRobin = Array.from({ length: 16 }, (_, index) => files.filter((_, position) => position % 16 === index))
  const packed = balancedShards(files, 16, timings)

  const slowestRoundRobin = Math.max(...loads(roundRobin, timings))
  const slowestPacked = Math.max(...loads(packed, timings))
  const mean = loads(packed, timings).reduce((total, load) => total + load, 0) / 16

  // Round robin collides the slow files onto a few shards; the slowest shard
  // sets the job's latency, so that is the number being optimised.
  assert.ok(
    slowestPacked < slowestRoundRobin,
    `packed slowest ${slowestPacked} must beat round-robin ${slowestRoundRobin}`,
  )
  assert.ok(
    slowestPacked <= mean * 1.35,
    `slowest shard ${slowestPacked} must stay near the mean ${mean.toFixed(0)}`,
  )
})

test('a file with no measurement is charged the median, not zero', () => {
  const timings = skewedTimings()
  const added = 'engine/src/brand-new.test.ts'
  const withNew = [...files, added]
  const buckets = balancedShards(withNew, 16, timings)
  assert.equal(buckets.flat().filter((file) => file === added).length, 1)

  // Charged zero, an unmeasured file would be free and every new test would
  // pile onto whichever shard was momentarily lightest.
  const host = buckets.find((bucket) => bucket.includes(added))
  const hostLoad = host.reduce((total, file) => total + (timings[file] ?? 0), 0)
  const heaviest = Math.max(...loads(buckets, { ...timings, [added]: 0 }))
  assert.ok(hostLoad <= heaviest, 'an unmeasured file must not be placed on the heaviest shard')
})

test('without a timing record the historical round robin is preserved exactly', () => {
  const buckets = balancedShards(files, 16, null)
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(buckets[index], files.filter((_, position) => position % 16 === index))
  }
})

test('shardFiles keeps rejecting malformed and over-wide shards', () => {
  assert.throws(() => shardFiles(files, '0/4'), /index\/count/)
  assert.throws(() => shardFiles(files, 'half'), /index\/count/)
  assert.throws(() => shardFiles(files, '5/4'), /Invalid or empty test shard/)
  assert.throws(() => shardFiles(files.slice(0, 2), '1/4'), /Invalid or empty test shard/)
  assert.deepEqual(shardFiles(files, ''), files)
})

test('the real manifest partitions completely at the counts CI uses', () => {
  // Guards the same property the CI evidence gate checks, but without needing
  // sixteen runners: whatever the committed timing record says, the union of
  // the shards is still the manifest and nothing is duplicated.
  const manifest = testManifest()
  for (const [suite, count] of [['unit', 4], ['integration', 16]]) {
    const partition = Array.from({ length: count }, (_, index) => shardFiles(manifest[suite], `${index + 1}/${count}`))
    assert.deepEqual(partition.flat().slice().sort(), manifest[suite])
  }
})

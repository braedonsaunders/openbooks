import assert from 'node:assert/strict'
import { test } from 'node:test'

import { balancedShards, shardFiles, testManifest } from './test-suite.mjs'

const files = Array.from({ length: 64 }, (_, index) => `engine/src/file-${String(index).padStart(2, '0')}.test.ts`)

test('shards are a deterministic round robin in repository order', () => {
  const buckets = balancedShards(files, 16)
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
  // sixteen runners: the union of the shards is the manifest and nothing is
  // duplicated.
  const manifest = testManifest()
  for (const [suite, count] of [['unit', 4], ['integration', 16]]) {
    const partition = Array.from({ length: count }, (_, index) => shardFiles(manifest[suite], `${index + 1}/${count}`))
    assert.deepEqual(partition.flat().slice().sort(), manifest[suite])
  }
})

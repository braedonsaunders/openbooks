// source-pin-contract: shard counts come from the CI test workflow's own matrices
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { balancedShards, fileWeight, shardFiles, testManifest } from './test-suite.mjs'

const files = Array.from({ length: 64 }, (_, index) => `engine/src/file-${String(index).padStart(2, '0')}.test.ts`)

test('shards are a deterministic round robin in repository order', () => {
  const buckets = balancedShards(files, 16)
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(buckets[index], files.filter((_, position) => position % 16 === index))
  }
})

test('a heavy file sorts first into the lightest shard', () => {
  const buckets = balancedShards(files, 4, files.map((_, index) => (index === 3 ? 10 : 1)))
  assert.equal(buckets[0][0], files[3])
  assert.deepEqual(buckets.flat().sort(), files.slice().sort())
})

test('shardFiles keeps rejecting malformed and over-wide shards', () => {
  for (const bad of ['0/4', 'half', '1/0', '1/8junk', '1.5/8']) {
    assert.throws(() => shardFiles(files, bad), /index\/count/)
  }
  for (const bad of ['5/4', '9/8', '1/99999']) {
    assert.throws(() => shardFiles(files, bad), /Invalid or empty test shard/)
  }
  assert.throws(() => shardFiles(files.slice(0, 2), '1/4'), /Invalid or empty test shard/)
  assert.deepEqual(shardFiles(files, ''), files)
  assert.deepEqual(shardFiles(files), files)
})

// Shard counts live in the CI matrices, so a widened matrix fails loudly here instead of silently dropping files.
const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')

function ciShardCount(job) {
  const matrix = /shard: \[([0-9,\s]+)\]/.exec(workflow.slice(workflow.indexOf(`\n  ${job}:\n`)))
  assert.ok(matrix, `${job} must declare its shard matrix`)
  return matrix[1].split(',').length
}

test('the real manifest partitions completely at the counts CI uses', () => {
  const manifest = testManifest()
  for (const [suite, job] of [['unit', 'unit'], ['integration', 'database']]) {
    const count = ciShardCount(job)
    const partition = Array.from({ length: count }, (_, index) => shardFiles(manifest[suite], `${index + 1}/${count}`))
    assert.deepEqual(partition.flat().slice().sort(), manifest[suite])
    assert.equal(new Set(partition.flat()).size, manifest[suite].length)
    assert.ok(partition.every((shard) => shard.length > 0))
    // Weighted packing: shard weights differ by at most one migration-runner spawner.
    const weights = partition.map((shard) => shard.reduce((sum, file) => sum + fileWeight(file), 0))
    assert.ok(Math.max(...weights) - Math.min(...weights) <= 31)
  }
})

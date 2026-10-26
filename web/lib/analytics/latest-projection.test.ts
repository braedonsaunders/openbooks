import assert from 'node:assert/strict'
import test from 'node:test'

delete process.env.OPENBOOKS_REDIS_URL
const { decodeProjection, encodeProjection, latestProjection, rebuildProjection } = await import('./latest-projection')

let sequence = 0
const uniqueKey = () => `test:latest-projection:${process.pid}:${++sequence}`

test('a kept projection is current until the revision moves, then answered at once as refreshing', async () => {
  const key = uniqueKey()
  let builds = 0
  const build = async () => ({ total: `${++builds}.0000` })

  const first = await latestProjection(key, 'r1', build)
  assert.deepEqual(first.data, { total: '1.0000' })
  assert.equal(first.refreshing, false, 'nothing kept yet: built before answering')
  assert.equal(builds, 1)

  const again = await latestProjection(key, 'r1', build)
  assert.deepEqual(again.data, { total: '1.0000' })
  assert.equal(again.refreshing, false, 'same revision inside the freshness window is current')
  assert.equal(builds, 1, 'a current projection is not rebuilt')

  const moved = await latestProjection(key, 'r2', build)
  assert.deepEqual(moved.data, { total: '1.0000' }, 'the last projection answers at once')
  assert.equal(moved.refreshing, true, 'and says it may be out of date')
  assert.equal(moved.observedAt, first.observedAt, 'with the time it was calculated')
  assert.equal(builds, 1, 'the rebuild is left to the caller')

  const rebuilt = await rebuildProjection(key, 'r2', build)
  assert.deepEqual(rebuilt.data, { total: '2.0000' })
  const current = await latestProjection(key, 'r2', build)
  assert.deepEqual(current.data, { total: '2.0000' })
  assert.equal(current.refreshing, false)
})

test('concurrent rebuilds of one projection share a single build, and a failed build keeps the last one', async () => {
  const key = uniqueKey()
  let builds = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const slow = async () => { builds += 1; await gate; return { n: builds } }
  const both = Promise.all([rebuildProjection(key, 'r', slow), rebuildProjection(key, 'r', slow)])
  release()
  const [a, b] = await both
  assert.equal(builds, 1)
  assert.deepEqual(a.data, b.data)

  await assert.rejects(rebuildProjection(key, 'r2', async () => { throw new Error('source unavailable') }), /source unavailable/)
  const kept = await latestProjection(key, 'r2', async () => ({ n: -1 }))
  assert.deepEqual(kept.data, { n: 1 }, 'the previous projection is still answered')
  assert.equal(kept.refreshing, true)
})

test('projection payloads keep their dates through storage', () => {
  const value = { at: new Date('2026-10-26T15:04:05.000Z'), rows: [{ created: new Date('2026-01-02T00:00:00.000Z'), label: 'x' }], text: '2026-10-26' }
  const revived = decodeProjection<typeof value>(encodeProjection(value)!)
  assert.ok(revived.at instanceof Date)
  assert.equal(revived.at.toISOString(), value.at.toISOString())
  assert.ok(revived.rows[0]!.created instanceof Date)
  assert.equal(revived.text, '2026-10-26', 'date-like text stays text')
})

test('a projection JSON cannot carry faithfully is answered but never kept', async () => {
  const key = uniqueKey()
  let builds = 0
  const build = async () => ({ byParty: new Map([['p1', ++builds]]) })
  const first = await latestProjection(key, 'r', build)
  assert.ok(first.data.byParty instanceof Map, 'the caller receives the value exactly as built')
  const again = await latestProjection(key, 'r', build)
  assert.equal(builds, 2, 'nothing was kept, so the next read builds again')
  assert.equal(again.data.byParty.get('p1'), 2)
  assert.equal(encodeProjection({ n: 1n }), null)
  assert.equal(encodeProjection({ rows: [1, undefined] }), null)
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import reporter from './test-timings-reporter.mjs'

const event = (file, name, duration) => ({ type: 'test:complete', data: {
  file, name, nesting: 0, details: { duration_ms: duration },
} })

test('completed assertions from a stalled file never become whole-file timings', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-timing-proof-'))
  const destination = join(directory, 'test-timings.json')
  const previous = process.env.OPENBOOKS_TEST_TIMINGS
  process.env.OPENBOOKS_TEST_TIMINGS = destination
  t.after(() => {
    if (previous === undefined) delete process.env.OPENBOOKS_TEST_TIMINGS
    else process.env.OPENBOOKS_TEST_TIMINGS = previous
    rmSync(directory, { recursive: true, force: true })
  })
  async function* events() {
    yield event('web/lib/gate-explanations.test.ts', 'gated route assertion', 6)
    yield event('scripts/finished.test.mjs', 'scripts/finished.test.mjs', 2300)
    // This assertion is evaluated while the stream is still open: the
    // incomplete record must survive an actual hung shard, not only clean EOF.
    const during = JSON.parse(readFileSync(destination, 'utf8'))
    assert.equal(during.files['web/lib/gate-explanations.test.ts'], undefined)
    assert.deepEqual(during.incompleteFiles['web/lib/gate-explanations.test.ts'], { assertionDurationMs: 6 })
    yield event('web/lib/later.test.ts', 'fast assertion', 2)
    yield event('web/lib/later.test.ts', 'web/lib/later.test.ts', 1900)
  }
  for await (const chunk of reporter(events())) assert.equal(chunk, '')
  const result = JSON.parse(readFileSync(destination, 'utf8'))
  assert.equal(result.version, 2)
  assert.deepEqual(result.files, { 'scripts/finished.test.mjs': 2300, 'web/lib/later.test.ts': 1900 })
  assert.deepEqual(result.incompleteFiles, { 'web/lib/gate-explanations.test.ts': { assertionDurationMs: 6 } })
})

test('recalibration refuses ambiguous legacy timings and excludes incomplete files', async () => {
  const { completedTimingEntries } = await import('./test-timings-merge.mjs')
  assert.throws(() => completedTimingEntries({ files: { 'stalled.test.ts': 6 } }, 'unit-4'),
    /unit-4:.*does not distinguish completed files.*re-run CI/)
  assert.deepEqual(completedTimingEntries({ version: 2,
    files: { 'finished.test.ts': 2300 },
    incompleteFiles: { 'stalled.test.ts': { assertionDurationMs: 6 } },
  }), [['finished.test.ts', 2300]])
})

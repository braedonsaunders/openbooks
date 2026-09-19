// Records measured wall clock per test file so shard membership can be packed
// by cost instead of by file count.
//
// Node reports every executed file as a nesting-0 `test:complete` whose name is
// the file operand, carrying the whole file's duration — setup, fixture resets
// and teardown included, not just the sum of its assertions. That file-level
// number is what the shard packer needs, and it is correct whether the runner
// ran files serially (the database partition pins --test-concurrency=1) or in
// parallel (the unit partition does not).
//
// Enabled only when OPENBOOKS_TEST_TIMINGS names an output path. This reporter
// emits nothing to its own destination; the human-facing reporter is untouched.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

/** Repository-relative, forward-slashed, and unescaped — the same key space
 * scripts/test-suite.mjs partitions on. Operands are glob-escaped for Node
 * (route segments such as [id]), so compare resolved real paths, never strings. */
function repositoryPath(file) {
  return relative(ROOT, resolve(ROOT, file)).split('\\').join('/')
}

export default async function* timingsReporter(source) {
  /** file -> { whole: number | undefined, parts: number } */
  const measured = new Map()
  const destination = process.env.OPENBOOKS_TEST_TIMINGS

  // Flush after every file rather than once at the end. The suites run under
  // --test-force-exit, which tears the process down as soon as the last test
  // settles — an end-of-stream write never lands. Flushing per file also means
  // a shard that times out still reports what it measured before the deadline.
  function flush() {
    if (!destination) return
    const files = {}
    for (const [file, { whole, parts }] of [...measured].sort(([left], [right]) => (left < right ? -1 : 1))) {
      // Prefer the file-level total. Fall back to the sum of its tests when the
      // file never completed, which understates rather than invents a cost.
      const duration = whole ?? parts
      if (duration > 0) files[file] = Math.round(duration)
    }
    mkdirSync(dirname(resolve(destination)), { recursive: true })
    writeFileSync(resolve(destination), `${JSON.stringify({ measuredAt: new Date().toISOString(), files }, null, 2)}\n`)
  }

  for await (const event of source) {
    if (event.type !== 'test:complete') continue
    const { name, file, nesting, details } = event.data ?? {}
    const duration = details?.duration_ms
    if (!file || nesting !== 0 || typeof duration !== 'number') continue

    const key = repositoryPath(file)
    const entry = measured.get(key) ?? { whole: undefined, parts: 0 }
    // The file-level event names the file itself; every other nesting-0 event
    // names a test inside it.
    const isWholeFile = name !== undefined && repositoryPath(name) === key
    if (isWholeFile) entry.whole = duration
    else entry.parts += duration
    measured.set(key, entry)
    if (isWholeFile) flush()
  }

  flush()

  // A reporter must be a transform; contribute nothing to the visible log.
  yield ''
}

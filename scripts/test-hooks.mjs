import { registerHooks } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EMPTY_MODULE = 'openbooks:test-hooks:empty'
// web/tsconfig.json maps the `@/*` house alias onto the web root. Mirror it
// here so `@/` resolves under node --test even when TSX_TSCONFIG_PATH is
// unset (tsx maps the same target when it is set — identical outcome, and
// per-file mock hooks registered later still take precedence).
const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'web')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { url: EMPTY_MODULE, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(resolvePath(WEB_ROOT, specifier.slice(2))).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === EMPTY_MODULE) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// A pg client that receives a second query while one is in flight only queues
// it — the fan-out never parallelizes — and node-postgres warns today and
// throws in pg 9. Fail the suite instead of letting the warning scroll past
// in a log: every transaction client is one connection, so concurrent use is
// always a defect at the call site.
const CONCURRENT_CLIENT_QUERY = 'already executing a query'
process.on('warning', (warning) => {
  if (
    warning?.name === 'DeprecationWarning' &&
    typeof warning.message === 'string' &&
    warning.message.includes(CONCURRENT_CLIENT_QUERY)
  ) {
    process.exitCode = 1
    console.error(`[test-hooks] refusing concurrent pg client use: ${warning.message}`)
  }
})

// Per-file registration receipt. scripts/test-suite.mjs also loads this
// module as a test reporter (`--test-reporter ./scripts/test-hooks.mjs`)
// so every shard accounts for its own files.
//
// Neither the spec nor the TAP reporter names the files that passed: both
// print test names only, and spec adds a file path solely for a file that
// fails to load. The test event stream is the only per-file signal. Every
// genuine test node (pass, fail, skip, todo) carries the entryFile of the
// file that registered it, while the file-level pseudo events a zero-test or
// load-dead file emits carry none. One receipt line per file, carrying its
// path and test count, therefore proves registration file by file, including
// the silent-zero shape (loads fine, registers nothing, exits zero) that no
// exit code sees. scripts/verify-test-registration.mjs reads this receipt.
export default async function* fileRegistrationReceipt(source) {
  const counts = new Map()
  for await (const event of source) {
    if (event?.type !== 'test:pass' && event?.type !== 'test:fail') continue
    const file = event?.data?.entryFile
    if (typeof file !== 'string' || file.length === 0) continue
    const entry = counts.get(file) ?? { tests: 0, failed: 0 }
    entry.tests += 1
    if (event.type === 'test:fail') entry.failed += 1
    counts.set(file, entry)
  }
  for (const file of [...counts.keys()].sort()) {
    const { tests, failed } = counts.get(file)
    yield `${JSON.stringify({ file, tests, failed })}\n`
  }
}

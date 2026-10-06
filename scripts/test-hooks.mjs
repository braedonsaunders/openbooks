import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const EMPTY_MODULE = 'openbooks:test-hooks:empty'
const CSS_MODULE = 'openbooks:test-hooks:css-module'
// web/tsconfig.json maps the `@/*` house alias onto the web root. Mirror it
// here so `@/` resolves under node --test even when TSX_TSCONFIG_PATH is
// unset (tsx maps the same target when it is set — identical outcome, and
// per-file mock hooks registered later still take precedence).
const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'web')

// Per-file hooks pin `@openbooks/engine/*` to their own checkout by joining
// the subpath onto `<checkout>/engine/`. Implementation paths are files, but
// a named contract (`@openbooks/engine/money`) is an export-map entry, so the
// joined path names no file. Resolve it through that checkout's own engine
// export map, which keeps the pin and makes contract imports load.
const engineExportMaps = new Map()
function engineContractUrl(specifier) {
  let path
  if (specifier.startsWith('file:')) {
    try { path = fileURLToPath(specifier) } catch { return null }
  } else if (specifier.startsWith('/')) path = specifier
  else return null
  const match = /^(.*\/engine)\/(?!src\/)([^?#]+)$/.exec(path)
  if (!match || existsSync(path)) return null
  const [, engineDir, subpath] = match
  if (!engineExportMaps.has(engineDir)) {
    let exportsMap = null
    try {
      const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'))
      if (manifest.name === '@openbooks/engine') exportsMap = manifest.exports ?? null
    } catch {}
    engineExportMaps.set(engineDir, exportsMap)
  }
  const target = engineExportMaps.get(engineDir)?.[`./${subpath}`]
  return typeof target === 'string' ? pathToFileURL(resolvePath(engineDir, target)).href : null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const contract = engineContractUrl(specifier)
    if (contract) return nextResolve(contract, context)
    if (specifier.endsWith('.module.css')) {
      return { url: CSS_MODULE, shortCircuit: true }
    }
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { url: EMPTY_MODULE, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(resolvePath(WEB_ROOT, specifier.slice(2))).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === CSS_MODULE) {
      // The bundler supplies scoped class names; Node render tests only need
      // the same named properties so CSS imports cannot prevent registration.
      return { format: 'module', source: 'export default new Proxy({}, { get: (_target, key) => String(key) })', shortCircuit: true }
    }
    if (url === EMPTY_MODULE) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// A pg client that receives a query while another is running only queues it:
// node-postgres warns today and refuses it from pg 9. Clients checked out
// through engine/src/platform/db.ts queue such calls themselves, so a
// Promise.all over a scoped transaction stays safe. Anything else that shares
// one client (a raw pg.Client in a fixture or script) must not, and the suite
// fails when it does rather than letting the warning scroll past in a log.
//
// pg's own warning names no caller, fires once per process, and only once a
// query is already waiting in the queue, so whether a two-query fan-out trips
// it depends on timing. The suite instead refuses what pg 9 refuses: a query
// issued while another is still running on the same client. It checks every
// call and prints each distinct call site. The warning listener stays as the
// backstop for a pg copy this does not patch.
const CONCURRENT_CLIENT_QUERY = 'already executing a query'
const REPOSITORY_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const reportedCallSites = new Set()
function refuseConcurrentQuery(stack) {
  process.exitCode = 1
  const site = String(stack ?? '')
    .split('\n')
    .slice(1)
    .filter((line) => line.includes(REPOSITORY_ROOT) && !line.includes('/node_modules/') && !line.includes('/scripts/test-hooks.mjs'))
    .map((line) => line.trim().replace(`file://${REPOSITORY_ROOT}/`, '').replace(`${REPOSITORY_ROOT}/`, ''))
    .slice(0, 8)
    .join('\n    ')
  if (reportedCallSites.has(site)) return
  reportedCallSites.add(site)
  console.error(`[test-hooks] refusing concurrent pg client use (a query issued while another runs on the same client) at:\n    ${site || '(no repository frame on the stack)'}`)
}
const clientQuery = pg.Client.prototype.query
pg.Client.prototype.query = function query(...args) {
  if (this._activeQuery || this._queryQueue?.length > 0) {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 60
    const stack = new Error().stack
    Error.stackTraceLimit = limit
    refuseConcurrentQuery(stack)
  }
  return clientQuery.apply(this, args)
}
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
// genuine test registration contributes to a file-specific summary. Empty or
// load-dead files can emit pass/fail pseudo events with a file and line, so
// those events cannot prove registration. One receipt line per file, carrying its
// path and test count, therefore proves registration file by file, including
// the silent-zero shape (loads fine, registers nothing, exits zero) that no
// exit code sees. scripts/verify-test-registration.mjs reads this receipt.
export default async function* fileRegistrationReceipt(source) {
  const counts = new Map()
  for await (const event of source) {
    if (event?.type !== 'test:summary') continue
    const { file, counts: summary } = event.data ?? {}
    if (typeof file !== 'string' || file.length === 0 || !Number.isInteger(summary?.tests) || summary.tests < 1) continue
    counts.set(file, { tests: summary.tests, failed: summary.failed })
  }
  for (const file of [...counts.keys()].sort()) {
    const { tests, failed } = counts.get(file)
    yield `${JSON.stringify({ file, tests, failed })}\n`
  }
}

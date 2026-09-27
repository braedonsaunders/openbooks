import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filesWithoutTests } from './verify-test-registration.mjs'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

// Node 24 shutdown can join a compiler worker that is awaiting main-thread GC.
// Confirmed on macOS and Ubuntu x64 / Node 24.20.0 (2026-09-20, diagnostic CI
// 35514084360): a passing test child entered native exit, then its main thread
// blocked in NodePlatform::Shutdown/uv_thread_join while Maglev workers waited
// in CollectionBarrier::AwaitCollectionBackground. This is not platform-local.
// Disable concurrent compilation in test processes on every platform; retain
// --test-force-exit and output draining. Production runtime flags are unchanged.
// Upstream: https://github.com/nodejs/node/issues/54918
export const TEST_RUNTIME_FLAGS = Object.freeze(['--no-concurrent-sparkplug', '--no-concurrent-recompilation'])


// Keep this list in one place. Every CI suite and the developer-facing `npm
// test` command derives its membership from the same inventory, so a new test
// cannot accidentally land in one job but not the other.
const TEST_PATTERNS = ['scripts', 'deploy', 'engine', 'packages', 'web', 'schema']
  .flatMap((root) => ['ts', 'tsx', 'js', 'mjs'].map((ext) => `${root}/**/*.test.${ext}`))

// Restore is an isolated disaster-recovery rehearsal. It has its own
// scheduled/manual workflow owner and must not run as part of the ordinary
// integration partition.
const RESTORE_TEST_FILES = new Set(['engine/src/backup/restore.integration.test.ts'])

function allTestFiles() {
  return [...new Set(TEST_PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: ROOT, nodir: true })))]
    .filter((file) => existsSync(resolve(ROOT, file)))
    .sort()
}

// Database ownership is derived from what a test file imports, never from a
// hand-kept list. The suffix decides when present: `.integration.test.*`
// is database-owned and `.unit.test.*` is not. Otherwise a file is
// database-owned when its runtime imports reach the tenant fixture module or
// any `*.integration.*` file. Imports are followed only through test code
// (test files, the shared helpers under engine/src/testing and web/testing,
// and `*.integration.*` files); following product modules would reach the
// database module from nearly every test in the tree.
//
// The database module itself is not a signal: pure tests import it to stub
// `db.execute` or read `env`. A test that uses a live database without a
// fixture must carry the integration suffix. Left unsuffixed it either fails
// loudly in the unit partition, which clears OPENBOOKS_DB_URL, or gates a skip
// on the database, which scripts/conformance-partition.test.mjs refuses.
const DATABASE_MODULES = new Set(['engine/src/testing/fixtures.ts'])
const INTEGRATION_FILE = /\.integration\.(?:[^/]+\.)?[cm]?[jt]sx?$/
const UNIT_TEST_FILE = /\.unit\.test\.[cm]?[jt]sx?$/
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const TEST_HELPER_ROOTS = ['engine/src/testing/', 'web/testing/']
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js']

function followsImports(file) {
  return TEST_FILE.test(file) || INTEGRATION_FILE.test(file) || TEST_HELPER_ROOTS.some((root) => file.startsWith(root))
}

let workspaceDirs
function workspaceDir(name) {
  if (!workspaceDirs) {
    workspaceDirs = new Map()
    for (const dir of ['schema', 'engine', 'web', ...globSync('packages/*', { cwd: ROOT })]) {
      try {
        workspaceDirs.set(JSON.parse(readFileSync(resolve(ROOT, dir, 'package.json'), 'utf8')).name, dir)
      } catch {}
    }
  }
  return workspaceDirs.get(name)
}

function resolveImport(from, specifier) {
  let base
  if (specifier.startsWith('.')) base = join(dirname(from), specifier)
  else if (specifier.startsWith('@/') && from.startsWith('web/')) base = join('web', specifier.slice(2))
  else {
    const match = /^(@openbooks\/[^/]+)\/(.+)$/.exec(specifier)
    const dir = match && workspaceDir(match[1])
    if (!dir) return undefined
    base = join(dir, match[2])
  }
  const stem = base.replace(/\.js$/, '')
  for (const candidate of [base, ...SOURCE_EXTENSIONS.map((ext) => stem + ext), ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`))]) {
    if (existsSync(resolve(ROOT, candidate)) && statSync(resolve(ROOT, candidate)).isFile()) return candidate
  }
  return undefined
}

// An import clause holds only bindings, braces, commas and `*`; anything
// else means the match ran past a statement that was not an import.
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(type\s+)?([\w\s{},*$]*?)\s*from\s*['"]([^'"]+)['"]/gm
const BARE_IMPORT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm
// `import("x").Name` in a type position is a type query, not a load.
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*,?\s*\)(?!\s*\.\s*(?!then\b)[A-Za-z_$])/g

function runtimeImports(file) {
  let text
  try {
    text = readFileSync(resolve(ROOT, file), 'utf8')
  } catch {
    return []
  }
  const specifiers = []
  for (const [, typeOnly, clause, specifier] of text.matchAll(STATIC_IMPORT)) {
    if (typeOnly) continue
    const named = /^\{([^}]*)\}$/.exec(clause.trim())
    if (named && named[1].split(',').map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith('type '))) continue
    specifiers.push(specifier)
  }
  for (const [, specifier] of text.matchAll(BARE_IMPORT)) specifiers.push(specifier)
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    const line = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index)
    if (!/^\s*(?:\/\/|\*)/.test(line)) specifiers.push(match[1])
  }
  return specifiers.map((specifier) => resolveImport(file, specifier)).filter(Boolean)
}

function databaseOwnedFiles(files) {
  const imports = new Map()
  const pending = [...files]
  while (pending.length > 0) {
    const file = pending.pop()
    if (imports.has(file)) continue
    const targets = followsImports(file) ? runtimeImports(file) : []
    imports.set(file, targets)
    pending.push(...targets)
  }
  // Propagate to a fixed point so an import cycle cannot hide a reachable fixture.
  const owned = new Set([...imports.keys()].filter((file) => DATABASE_MODULES.has(file) || INTEGRATION_FILE.test(file)))
  for (let grew = true; grew;) {
    grew = false
    for (const [file, targets] of imports) {
      if (owned.has(file) || !targets.some((target) => owned.has(target))) continue
      owned.add(file)
      grew = true
    }
  }
  return new Set(files.filter((file) => owned.has(file) && !UNIT_TEST_FILE.test(file)))
}

export function testManifest() {
  const all = allTestFiles()
  const restore = all.filter((file) => RESTORE_TEST_FILES.has(file))
  const restoreSet = new Set(restore)
  const databaseOwned = databaseOwnedFiles(all)
  const integration = all.filter((file) => databaseOwned.has(file) && !restoreSet.has(file))
  const integrationSet = new Set(integration)
  const unit = all.filter((file) => !integrationSet.has(file) && !restoreSet.has(file))
  return { all, unit, integration, restore }
}

// A test that spawns the migration runner pays a full migrate-and-provision
// cycle per spawn on top of its own cases: the heaviest replay suite in the
// tree measures about thirty average files, so packing by count alone piles a
// full companion set onto the spawner's shard and that shard nears its job
// timeout while still passing. The reference is quoted because every spawner
// passes the entrypoint as a process argument; unquoted mentions such as the
// history notes in the migration-ordinal tests do not match.
const MIGRATION_RUNNER_PATTERN = /["'`]scripts\/bootstrap\.ts["'`]/
const MIGRATION_RUNNER_WEIGHT = 30

const fileWeightCache = new Map()

export function fileWeight(file) {
  const cached = fileWeightCache.get(file)
  if (cached !== undefined) return cached
  let weight = 1
  try {
    if (MIGRATION_RUNNER_PATTERN.test(readFileSync(resolve(ROOT, file), 'utf8'))) {
      weight += MIGRATION_RUNNER_WEIGHT
    }
  } catch {
    weight = 1
  }
  fileWeightCache.set(file, weight)
  return weight
}

/**
 * Deal files into `count` buckets, heaviest first, each into the currently
 * lightest bucket (ties keep repository order and the lowest bucket index).
 *
 * Deterministic and total by construction: the CI "Verify every test file ran
 * exactly once" gate re-derives this partition and compares it to what each
 * runner actually executed. Weights are derived from the tree on every run —
 * no hand list of files — and committed timing records stay out of the
 * repository: a quoted migration-runner reference marks the spawner class
 * and everything else weighs one file, which degrades exactly to the
 * historical round robin. An explicit weight table exists for tests only, so
 * the packing pins without coupling to tree contents.
 */
export function balancedShards(files, count, weights) {
  const buckets = Array.from({ length: count }, () => [])
  const totals = new Array(count).fill(0)
  const order = files
    .map((_, index) => index)
    .sort((left, right) => {
      const difference = (weights?.[right] ?? fileWeight(files[right])) - (weights?.[left] ?? fileWeight(files[left]))
      return difference === 0 ? left - right : difference
    })
  for (const index of order) {
    let best = 0
    for (let bucket = 1; bucket < count; bucket += 1) {
      if (totals[bucket] < totals[best]) best = bucket
    }
    buckets[best].push(files[index])
    totals[best] += weights?.[index] ?? fileWeight(files[index])
  }
  return buckets
}

/** Partition whole files across independent databases; never share fixture owners. */
export function shardFiles(files, shard) {
  if (shard === undefined || shard === '') return files
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard)
  if (!match) throw new Error('OPENBOOKS_TEST_SHARD must be index/count, starting at 1')
  const index = Number(match[1]), count = Number(match[2])
  if (!Number.isSafeInteger(count) || index > count || count > files.length) {
    throw new Error('Invalid or empty test shard')
  }
  return balancedShards(files, count)[index - 1]
}

function printManifest() {
  process.stdout.write(`${JSON.stringify(testManifest(), null, 2)}\n`)
}

/** Node's --test operands are globs even when they name an existing file.
 * Escape route segments such as [id] so discovery and execution agree. */
export function literalTestPath(file) {
  return file.replace(/[\[\]*?{}]/g, (character) => `[${character}]`)
}

export function runChild(args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [...TEST_RUNTIME_FLAGS, ...args], { cwd: ROOT, stdio: 'inherit', env })
    child.once('error', reject)
    child.once('close', (status, signal) => resolveResult(status ?? (signal ? 1 : 0)))
  })
}

function ownerRequest(port, request, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolveResult(value)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('fixture owner close timed out')))
    socket.once('error', (error) => finish(error))
    socket.once('close', () => finish(new Error('fixture owner closed without a response')))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        finish(error)
      }
    })
    // This is a newline-framed request, not an EOF-framed request. Half-closing
    // here makes the server close its response side before async cleanup ends.
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
  })
}

const RECEIPT_PATH = resolve(ROOT, '.local', 'fixture-lifecycle-receipt.txt')
// One line per test file ({ file, tests, failed }), written by the receipt
// reporter below. A stale file from an earlier run would vouch for files
// this run never started, so runSuite removes it before the child runs.
const REGISTRATION_RECEIPT_PATH = resolve(ROOT, '.local', 'test-file-registration.jsonl')

async function startFixtureOwner(env) {
  const owner = spawn(process.execPath, [
    ...TEST_RUNTIME_FLAGS,
    '--import', 'tsx',
    '--import', './engine/src/testing/database-bypass.ts',
    './scripts/test-fixture-lifecycle.mjs', '--owner',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env })
  let output = ''
  let readyResolve
  let readyReject
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady
    readyReject = rejectReady
  })
  owner.stdout.on('data', (chunk) => {
    output += chunk.toString()
    for (const line of output.split('\n')) {
      const match = line.match(/^FIXTURE_OWNER_READY (\d+)$/)
      if (match) readyResolve(Number(match[1]))
    }
  })
  owner.once('error', readyReject)
  owner.once('close', (status) => {
    if (!readyResolve) return
    readyReject(new Error(`fixture owner exited before readiness (status ${status})`))
  })
  const timeout = setTimeout(() => readyReject(new Error('fixture owner readiness timed out')), 120_000)
  try {
    const port = await ready
    return { owner, port, get output() { return output }, clearTimeout: () => clearTimeout(timeout) }
  } catch (error) {
    clearTimeout(timeout)
    owner.kill()
    throw error
  }
}

export async function stopFixtureOwner(handle, { timeoutMs = 120_000 } = {}) {
  handle.clearTimeout()
  // Subscribe before sending the request: TCP response and process close can
  // arrive in either order. A referenced timeout also prevents silent exit.
  const completion = new Promise((resolveClose) => {
    if (handle.owner.exitCode != null || handle.owner.signalCode != null) {
      resolveClose(handle.owner.exitCode ?? 1)
      return
    }
    const timer = setTimeout(() => {
      handle.owner.kill('SIGKILL')
      resolveClose(1)
    }, timeoutMs)
    handle.owner.once('close', (status) => {
      clearTimeout(timer)
      resolveClose(status ?? 1)
    })
  })
  let response
  try {
    response = await ownerRequest(handle.port, { op: 'close' }, timeoutMs)
  } finally {
    const ownerStatus = await completion
    if (ownerStatus !== 0) response = { ok: false }
    if (handle.output) {
      process.stdout.write(handle.output)
      // Also persist the lifecycle receipt to a file. The stdout copy travels
      // through `tee` and can be lost when the process exits before the pipe
      // drains, which silently failed the CI receipt gate while every test
      // passed. A file is not subject to that race.
      const receipt = handle.output.split('\n').find((line) => line.startsWith('[fixture-lifecycle] '))
      if (receipt) {
        mkdirSync(dirname(RECEIPT_PATH), { recursive: true })
        writeFileSync(RECEIPT_PATH, receipt + '\n')
      }
    }
  }
  return response
}

async function runSuite(suite, forwarded, envOverrides = {}) {
  const manifest = testManifest()
  let files = manifest[suite]
  if (!files) {
    throw new Error(`unknown test suite ${JSON.stringify(suite)}; expected unit, integration, or all`)
  }
  if (process.env.OPENBOOKS_TEST_SHARD) {
    if (suite !== 'integration' && suite !== 'unit') throw new Error('Sharding is supported only for unit and integration partitions')
    if (forwarded.some((argument) => argument.startsWith('--test-shard'))) throw new Error('Cannot shard a partition twice')
    files = shardFiles(files, process.env.OPENBOOKS_TEST_SHARD)
  }
  if (files.length === 0) throw new Error(`${suite} suite resolved to no test files`)
  if ((suite === 'integration' || suite === 'restore' || suite === 'all') && !process.env.OPENBOOKS_DB_URL?.trim()) {
    throw new Error(`${suite} suite requires OPENBOOKS_DB_URL; refusing to report self-skipped database tests`)
  }
  if (suite === 'unit' && process.env.OPENBOOKS_DB_URL?.trim()) {
    throw new Error('unit suite requires OPENBOOKS_DB_URL to be empty; run the integration suite for database tests')
  }
  if ((suite === 'restore' || suite === 'all') && process.env.OPENBOOKS_RESTORE_DRILL !== '1') {
    throw new Error(`${suite} suite requires OPENBOOKS_RESTORE_DRILL=1; refusing to report an unrun restore drill`)
  }

  mkdirSync(resolve(ROOT, '.local'), { recursive: true })
  writeFileSync(resolve(ROOT, '.local/test-selection.json'), JSON.stringify({ suite, shard: process.env.OPENBOOKS_TEST_SHARD ?? null, files }, null, 2) + '\n')
  rmSync(REGISTRATION_RECEIPT_PATH, { force: true })

  const pooled = suite === 'integration'
  // Adding any reporter replaces the default spec-to-stdout output, which
  // the skip audit and the engineers read. When the caller forwards its own
  // reporters (the coverage run does), only the receipt is added; otherwise
  // the default is restored explicitly alongside it.
  const callerOwnsReporters = forwarded.some(
    (argument) => argument === '--test-reporter' || argument.startsWith('--test-reporter='),
  )
  const childEnv = {
    ...process.env,
    ...envOverrides,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    TSX_TSCONFIG_PATH: resolve(ROOT, 'web/tsconfig.json'),
    OPENBOOKS_TRUSTED_TEST_BYPASS: process.env.OPENBOOKS_TRUSTED_TEST_BYPASS ?? '1',
    OPENBOOKS_TEST_FIXTURE_BEHAVIOR: process.env.OPENBOOKS_TEST_FIXTURE_BEHAVIOR ?? '1',
    ...(pooled
      ? {
          OPENBOOKS_TEST_FIXTURE_POOL: process.env.OPENBOOKS_TEST_FIXTURE_POOL ?? '1',
          OPENBOOKS_TEST_FIXTURE_POOL_SIZE: process.env.OPENBOOKS_TEST_FIXTURE_POOL_SIZE ?? '4',
        }
      : {}),
  }
  const args = [
    '--import',
    './scripts/test-output-drain.mjs',
    '--import',
    'tsx',
    '--import',
    './scripts/test-hooks.mjs',
    '--import',
    './engine/src/testing/database-bypass.ts',
    ...(pooled ? ['--import', './scripts/test-fixture-lifecycle.mjs'] : []),
    '--test',
    '--test-force-exit',
    // A reporter alongside any the caller forwards. Spec and TAP name only
    // tests, never the files that passed, so per-file registration is
    // receipted from the event stream instead. The reporter lives in the
    // hooks module the suite already imports into every test process; the
    // destination file lets this suite refuse a silent file itself rather
    // than waiting for the CI exactly-once gate to notice.
    ...(callerOwnsReporters ? [] : ['--test-reporter', 'spec', '--test-reporter-destination', 'stdout']),
    '--test-reporter', './scripts/test-hooks.mjs',
    '--test-reporter-destination', REGISTRATION_RECEIPT_PATH,
    ...forwarded,
    ...(suite === 'unit' ? ['--test-timeout=180000'] : []),
    // Database files share a disposable schema and many exercise deliberate
    // lock/claim races internally. Keep file-level execution serial so one
    // fixture cannot contend with another while preserving each test's own
    // concurrency assertions.
    ...((suite === 'integration' || suite === 'restore' || suite === 'all') ? ['--test-concurrency=1'] : []),
    ...files.map(literalTestPath),
  ]
  let owner
  try {
    if (pooled) {
      owner = await startFixtureOwner(childEnv)
      childEnv.OPENBOOKS_TEST_FIXTURE_OWNER_PORT = String(owner.port)
    }
    let status = await runChild(args, childEnv)
    // Remain failed until both child execution and shutdown evidence complete.
    process.exitCode = 1
    let ownerStatus = 0
    if (owner) {
      const response = await stopFixtureOwner(owner)
      ownerStatus = response?.ok ? 0 : 1
    }
    // Refuse a silent file structurally: a selected file with no receipt
    // line is a failure even when the child exits zero. A missing receipt
    // proves nothing, so it fails closed with every file silent.
    let silentFiles = files
    try {
      silentFiles = filesWithoutTests(files, readFileSync(REGISTRATION_RECEIPT_PATH, 'utf8'))
    } catch {
      // Fall through with every file silent.
    }
    if (silentFiles.length > 0) {
      status = 1
      process.stderr.write(
        `test registration: ${silentFiles.length} selected file(s) registered no tests:\n` +
          silentFiles.map((file) => `  ${file}`).join('\n') + '\n',
      )
    }
    process.exitCode = status === 0 && ownerStatus === 0 ? 0 : 1
  } catch (error) {
    process.exitCode = 1
    if (owner) {
      try { await stopFixtureOwner(owner) } catch {}
    }
    throw error
  }
  return process.exitCode ?? 1
}

async function main() {
  const [suite, ...forwarded] = process.argv.slice(2)
  if (suite === 'manifest') printManifest()
  else if (suite === 'all') {
    // Keep the no-database and restore partitions on their historical
    // per-file workers. Only the pooled integration partition is collapsed
    // into one owner process.
    const statuses = []
    statuses.push(await runSuite('unit', forwarded, { OPENBOOKS_DB_URL: '' }))
    statuses.push(await runSuite('integration', forwarded))
    statuses.push(await runSuite('restore', forwarded))
    process.exitCode = statuses.find((status) => status !== 0) ?? 0
  } else await runSuite(suite ?? 'all', forwarded)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

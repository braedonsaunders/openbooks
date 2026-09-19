import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

// Node 24 on macOS can deadlock at process.exit while its background Sparkplug
// compiler awaits GC and the main thread joins that compiler. Stack sampling
// also confirmed the same cycle in Maglev, so disable background optimizing
// compilation as well. Keep test shutdown synchronous on
// that host; production execution and Linux CI retain their runtime defaults.
const TEST_RUNTIME_FLAGS = process.platform === 'darwin' ? ['--no-concurrent-sparkplug', '--no-concurrent-recompilation'] : []


// Keep this list in one place. Every CI suite and the developer-facing `npm
// test` command derives its membership from the same inventory, so a new test
// cannot accidentally land in one job but not the other.
const TEST_PATTERNS = ['scripts', 'deploy', 'engine', 'packages', 'web', 'schema']
  .flatMap((root) => ['ts', 'tsx', 'js', 'mjs'].map((ext) => `${root}/**/*.test.${ext}`))

// Most database tests predate the `.integration.test.ts` naming convention.
// Keep their ownership explicit here instead of guessing from arbitrary
// source text (which would misclassify contract tests that merely mention a
// database environment variable). New database tests should use the suffix;
// this list is the maintained compatibility inventory for legacy files.
const DATABASE_TEST_OVERRIDES = new Set([
  'scripts/test-fixture-architecture.test.mjs',
  'engine/src/ap-capture.test.ts',
  'engine/src/bank-feed-providers.test.ts',
  'engine/src/business-date.test.ts',
  'engine/src/close.test.ts',
  'engine/src/conformance/conformance.test.ts',
  'engine/src/conformance/controls.test.ts',
  'engine/src/control-accounts.test.ts',
  'engine/src/direct-debit.test.ts',
  'engine/src/dunning.test.ts',
  'engine/src/fx-providers.test.ts',
  // Proves the pack-refusal hierarchy at the real boundary: it installs every
  // declared country and runs their population() calls, which needs a database.
  // Left in the unit partition its DB block silently skipped, so the guard for
  // the year-end crash was never actually exercised in CI.
  'engine/src/payroll-pack-refusal-class.test.ts',
  'engine/src/harness/scenario.test.ts',
  'engine/src/inventory-costing.test.ts',
  'engine/src/journal-writes.test.ts',
  'engine/src/payment-operations.test.ts',
  'engine/src/payroll-agnostic-core.test.ts',
  'engine/src/payroll-bank-file.test.ts',
  'engine/src/payroll-controls.test.ts',
  'engine/src/payroll-derived-earnings.test.ts',
  'engine/src/payroll-entitlements.test.ts',
  'engine/src/payroll-filing-registry.test.ts',
  'engine/src/payroll-opening-balances.test.ts',
  'engine/src/payroll-opening-entitlements.test.ts',
  'engine/src/payroll-payment-method.test.ts',
  'engine/src/payroll-roexml.test.ts',
  'engine/src/payroll-run.test.ts',
  'engine/src/payroll-statutory-rates.test.ts',
  'engine/src/payroll-statutory-rate-history.test.ts',
  'engine/src/payroll-tax-years.test.ts',
  'engine/src/payroll-yearend-amendments.test.ts',
  'engine/src/posting-subsidiary-restrictions.test.ts',
  'engine/src/posting.test.ts',
  'engine/src/revenue-recognition.test.ts',
  'engine/src/sync/migrate.test.ts',
  'engine/src/sync/source-deletions.test.ts',
  'engine/src/tax-rate-providers.test.ts',
  'engine/src/work-schedules.test.ts',
  'web/app/api/account-groups/[id]/route.test.ts',
  'web/app/api/admin/setup/[entity]/route.test.ts',
  'web/app/api/file-cabinet/files/route.test.ts',
  'web/app/api/file-cabinet/lib.test.ts',
  'web/app/api/insights/_lib.test.ts',
  'web/app/api/items/[id]/fair-values/route.test.ts',
  'web/app/api/payments/webhooks/[provider]/route.test.ts',
  'web/app/api/payroll/runs/subsidiary-scope.test.ts',
  'web/app/api/payroll/settings/route.test.ts',
  'web/lib/analytics/vendor-data.test.ts',
  'web/lib/api-auth.test.ts',
  'web/lib/application/document-concurrency.test.ts',
  'web/lib/application/records.test.ts',
  'web/lib/apps/platform.test.ts',
  'web/lib/apps/store-audit.test.ts',
  'web/lib/cash-flow-indirect.test.ts',
  'web/lib/data-io/setup-resources.test.ts',
  'web/lib/documents.test.ts',
  'web/lib/feature-gating.test.ts',
  'web/lib/file-cabinet.private-boundary.test.ts',
  'web/lib/multi-book-balance-readers.test.ts',
  'web/lib/rate-adjustment-pricing.test.ts',
  'web/lib/reports-posted.test.ts',
  'web/lib/setup-route-contract.test.ts',
])

// Restore is an isolated disaster-recovery rehearsal. It has its own
// scheduled/manual workflow owner and must not run as part of the ordinary
// integration partition.
const RESTORE_TEST_FILES = new Set(['engine/src/backup-restore.integration.test.ts'])

function allTestFiles() {
  return [...new Set(TEST_PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: ROOT, nodir: true })))]
    .filter((file) => existsSync(resolve(ROOT, file)))
    .sort()
}

// A file is database-owned when it explicitly opts into the database contract
// or carries the repository's integration suffix. This catches the handful of
// legacy files that contain both pure and database-backed cases without relying
// on naming alone; each file still executes exactly once in CI.
function isDatabaseOwned(file) {
  return /\.integration\.test\.(?:tsx?|mjs|js)$/.test(file) || DATABASE_TEST_OVERRIDES.has(file)
}

export function testManifest() {
  const all = allTestFiles()
  const restore = all.filter((file) => RESTORE_TEST_FILES.has(file))
  const restoreSet = new Set(restore)
  const integration = all.filter((file) => isDatabaseOwned(file) && !restoreSet.has(file))
  const integrationSet = new Set(integration)
  const unit = all.filter((file) => !integrationSet.has(file) && !restoreSet.has(file))
  return { all, unit, integration, restore }
}

// Measured per-file wall clock, in milliseconds, recorded by
// scripts/test-timings-reporter.mjs and refreshed by `npm run test:timings`.
// Shard membership is derived from it, so it is data rather than
// configuration: a stale or absent entry costs balance, never correctness.
const TIMINGS_PATH = resolve(ROOT, 'scripts/test-timings.json')

let timingsCache
export function fileTimings() {
  if (timingsCache !== undefined) return timingsCache
  timingsCache = null
  if (existsSync(TIMINGS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(TIMINGS_PATH, 'utf8'))
      if (parsed && typeof parsed.files === 'object' && parsed.files !== null) timingsCache = parsed.files
    } catch {
      // A corrupt record must not take CI down; fall back to file-count balance.
      timingsCache = null
    }
  }
  return timingsCache
}

/**
 * Split files into `count` buckets of approximately equal measured cost.
 *
 * File-count balance is the wrong objective: the 16 database shards held an
 * even 63-64 files each and still spread 312s-632s, because per-file cost
 * ranges over three orders of magnitude. The slowest shard sets the job's
 * latency, so pack by recorded duration instead — longest-processing-time
 * first, which keeps the worst bucket near the mean rather than near the sum
 * of whatever the round robin happened to collide.
 *
 * Deterministic and total by construction: the CI "Verify every test file ran
 * exactly once" gate re-derives this partition and compares it to what each
 * runner actually executed, so ties break on path and never on iteration order.
 */
export function balancedShards(files, count, timings = fileTimings()) {
  const buckets = Array.from({ length: count }, () => [])
  if (!timings) {
    // No measurements yet. Preserve the historical round robin so a fresh
    // checkout still partitions identically on every runner.
    files.forEach((file, position) => buckets[position % count].push(file))
    return buckets
  }
  const weightOf = (file) => (typeof timings[file] === 'number' && timings[file] > 0 ? timings[file] : undefined)
  const measured = files.map(weightOf).filter((weight) => weight !== undefined).sort((left, right) => left - right)
  if (measured.length === 0) {
    files.forEach((file, position) => buckets[position % count].push(file))
    return buckets
  }
  // A test added since the last calibration is charged the median, so it is
  // neither ignored (which would overload its shard) nor treated as the worst
  // case (which would strand a runner).
  const fallback = measured[Math.floor(measured.length / 2)]
  const ordered = files
    .map((file) => ({ file, weight: weightOf(file) ?? fallback }))
    .sort((left, right) => right.weight - left.weight || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  const load = new Array(count).fill(0)
  for (const { file, weight } of ordered) {
    let target = 0
    for (let candidate = 1; candidate < count; candidate += 1) if (load[candidate] < load[target]) target = candidate
    buckets[target].push(file)
    load[target] += weight
  }
  // Run each shard in repository order so a shard's log reads the way it
  // always has; only membership changes, not execution order within a shard.
  const position = new Map(files.map((file, index) => [file, index]))
  for (const bucket of buckets) bucket.sort((left, right) => position.get(left) - position.get(right))
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

async function startFixtureOwner(env) {
  const owner = spawn(process.execPath, [
    ...TEST_RUNTIME_FLAGS,
    '--import', 'tsx',
    '--import', './engine/src/test-database-bypass.ts',
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

  const pooled = suite === 'integration'
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
    './engine/src/test-database-bypass.ts',
    ...(pooled ? ['--import', './scripts/test-fixture-lifecycle.mjs'] : []),
    '--test',
    '--test-force-exit',
    ...forwarded,
    // Measure per-file cost so `npm run test:timings` can repack the shards.
    // Naming any reporter suppresses Node's default, so restore the spec
    // output when the caller did not already choose one.
    ...(process.env.OPENBOOKS_TEST_TIMINGS
      ? [
          ...(forwarded.some((argument) => argument.startsWith('--test-reporter'))
            ? []
            : ['--test-reporter=spec', '--test-reporter-destination=stdout']),
          '--test-reporter=./scripts/test-timings-reporter.mjs',
          '--test-reporter-destination=stdout',
        ]
      : []),
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
    const status = await runChild(args, childEnv)
    // Remain failed until both child execution and shutdown evidence complete.
    process.exitCode = 1
    let ownerStatus = 0
    if (owner) {
      const response = await stopFixtureOwner(owner)
      ownerStatus = response?.ok ? 0 : 1
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

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, globSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

// Keep this list in one place. Every CI suite and the developer-facing `npm
// test` command derives its membership from the same inventory, so a new test
// cannot accidentally land in one job but not the other.
const TEST_PATTERNS = [
  'scripts/check-repository-artifacts.test.mjs',
  'scripts/deploy-edge-workflow.test.mjs',
  'scripts/ci-pipeline-integrity.test.mjs',
  'engine/**/*.test.ts',
  'packages/**/*.test.ts',
  'web/**/*.test.ts',
  'schema/**/*.test.ts',
]

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
  'engine/src/control-accounts.test.ts',
  'engine/src/dashboard-reporting.test.ts',
  'engine/src/direct-debit.test.ts',
  'engine/src/dunning.test.ts',
  'engine/src/fx-providers.test.ts',
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
  return /\.integration\.test\.(?:ts|mjs|js)$/.test(file) || DATABASE_TEST_OVERRIDES.has(file)
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

function printManifest() {
  process.stdout.write(`${JSON.stringify(testManifest(), null, 2)}\n`)
}

export function runChild(args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
    child.once('error', reject)
    child.once('close', (status, signal) => resolveResult(status ?? (signal ? 1 : 0)))
  })
}

function ownerRequest(port, request) {
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
    socket.setTimeout(120_000, () => finish(new Error('fixture owner close timed out')))
    socket.once('error', (error) => finish(error))
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
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`))
  })
}

const RECEIPT_PATH = resolve(ROOT, '.local', 'fixture-lifecycle-receipt.txt')

async function startFixtureOwner(env) {
  const owner = spawn(process.execPath, [
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

export async function stopFixtureOwner(handle) {
  handle.clearTimeout()
  let response
  try {
    response = await ownerRequest(handle.port, { op: 'close' })
  } finally {
    await new Promise((resolveClose) => handle.owner.once('close', resolveClose))
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
  const files = manifest[suite]
  if (!files) {
    throw new Error(`unknown test suite ${JSON.stringify(suite)}; expected unit, integration, or all`)
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

  const pooled = suite === 'integration'
  const childEnv = {
    ...process.env,
    ...envOverrides,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
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
    'tsx',
    '--import',
    './engine/src/test-database-bypass.ts',
    ...(pooled ? ['--import', './scripts/test-fixture-lifecycle.mjs'] : []),
    '--test',
    '--test-force-exit',
    ...forwarded,
    // Database files share a disposable schema and many exercise deliberate
    // lock/claim races internally. Keep file-level execution serial so one
    // fixture cannot contend with another while preserving each test's own
    // concurrency assertions.
    ...((suite === 'integration' || suite === 'restore' || suite === 'all') ? ['--test-concurrency=1'] : []),
    ...files,
  ]
  let owner
  try {
    if (pooled) {
      owner = await startFixtureOwner(childEnv)
      childEnv.OPENBOOKS_TEST_FIXTURE_OWNER_PORT = String(owner.port)
    }
    const status = await runChild(args, childEnv)
    let ownerStatus = 0
    if (owner) {
      const response = await stopFixtureOwner(owner)
      ownerStatus = response?.ok ? 0 : 1
    }
    process.exitCode = status === 0 && ownerStatus === 0 ? 0 : 1
  } catch (error) {
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

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { testManifest } from './test-suite.mjs'

// A test file that touches the database contract (reads OPENBOOKS_DB_URL,
// leases a fixture tenant, or self-skips without a database) cannot live in
// the unit partition: its ledger cases would skip while ordinary npm test
// stays green. Pure files may live anywhere; database-backed files must be
// database-owned (the `.integration.test.ts` suffix or a
// DATABASE_TEST_OVERRIDES entry, as resolved by the single testManifest
// source of truth).
const DATABASE_SIGNALS = /OPENBOOKS_DB_URL|test-fixtures|createConformanceOrg|from\s+['"]\.\/roles(\.ts)?['"]|skip:\s*!/

function needsDatabase(file) {
  return DATABASE_SIGNALS.test(readFileSync(join('engine/src/conformance', file), 'utf8'))
}

test('no conformance test file can self-skip in the unit partition', () => {
  const manifest = testManifest()
  const integration = new Set(manifest.integration)
  const files = manifest.all
    .filter((file) => file.startsWith('engine/src/conformance/'))
    .map((file) => file.slice('engine/src/conformance/'.length))
  assert.ok(files.length > 0, 'expected conformance test files to exist')
  for (const file of files) {
    if (!needsDatabase(file)) continue
    assert.ok(
      integration.has(`engine/src/conformance/${file}`),
      `engine/src/conformance/${file} touches the database contract, so it must run in the database partition`,
    )
  }
})

// The property, asserted repo-wide rather than by this guard's reach: a
// unit-partition file that gates a skip on the database contract never runs
// ANYWHERE — the unit partition forces OPENBOOKS_DB_URL empty and the file
// is absent from the integration manifest. Three refusal cases sat dead for
// exactly this reason (custom-report-books, bank-file-cemtex x2) while
// npm test stayed green. Only files git would track are judged: local
// ignored scratch probes are invisible to CI and would fail only the
// developer's own run.
const DB_GATED_SKIP = /skip\s*:\s*![^,}]{0,160}?(OPENBOOKS_DB_URL|databaseUrl|\bDB\b|test-fixtures|fixtureOwner|OPENBOOKS_TEST_FIXTURE)/i

// The skip guards' own tests deliberately contain skip-shaped fixture text
// to exercise the guards themselves; they are tests OF the shape, not of the
// database contract.
const GUARD_FIXTURE_FILES = new Set([
  'scripts/check-test-skips.test.mjs',
  'scripts/conformance-partition.test.mjs',
])

test('no unit-partition test file can gate a skip on the database contract', () => {
  const manifest = testManifest()
  const integration = new Set(manifest.integration)
  assert.ok(integration.size > 0, 'expected a non-empty integration partition')
  let visible = null
  try {
    visible = new Set(execFileSync('git', ['ls-files', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean))
  } catch {
    visible = null // no git metadata: judge every file, fail closed
  }
  const dead = []
  for (const file of manifest.unit) {
    if (GUARD_FIXTURE_FILES.has(file)) continue
    if (visible && !visible.has(file)) continue
    if (!DB_GATED_SKIP.test(readFileSync(file, 'utf8'))) continue
    dead.push(file)
  }
  assert.deepEqual(
    dead,
    [],
    `${dead.length} unit-partition file(s) gate a skip on the database contract, so their cases never run in ANY partition:\n${dead.join('\n')}\nrename to *.integration.test.ts or add a DATABASE_TEST_OVERRIDES entry in scripts/test-suite.mjs`,
  )
})

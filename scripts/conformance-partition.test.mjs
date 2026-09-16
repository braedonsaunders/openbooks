import assert from 'node:assert/strict'
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

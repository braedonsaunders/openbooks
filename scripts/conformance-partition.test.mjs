import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testManifest } from './test-suite.mjs'

test('no conformance test file can self-skip in the unit partition', () => {
  // Ledger-tier control and standards cases post through the real kernel and
  // self-skip without a database. If their file ever lands in the unit
  // partition, ordinary npm test stays green while asserting nothing — the
  // exact failure this gate exists to prevent. Every test file under
  // engine/src/conformance must therefore be database-owned (the
  // `.integration.test.ts` suffix or a DATABASE_TEST_OVERRIDES entry, as
  // resolved by the single testManifest source of truth).
  const manifest = testManifest()
  const integration = new Set(manifest.integration)
  const conformance = manifest.all.filter((file) => file.startsWith('engine/src/conformance/'))
  assert.ok(conformance.length > 0, 'expected conformance test files to exist')
  for (const file of conformance) {
    assert.ok(
      integration.has(file),
      `${file} must run in the database partition: its ledger cases self-skip without OPENBOOKS_DB_URL`,
    )
  }
})

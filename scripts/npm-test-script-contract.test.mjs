// source-pin-contract: npm test trusted-bypass env contract for DB-backed suites (package.json test script)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The `npm test` entrypoint carries the trusted-bypass contract the suite's
 * DB-backed files need: without OPENBOOKS_TRUSTED_TEST_BYPASS every
 * database-owned file throws on import and the run quietly measures a
 * smaller suite. The workflow contract tests
 * (scripts/ci-pipeline-integrity.test.mjs) scope their glob assertions on
 * this script carrying the contract, so it is pinned here, next to the
 * script, rather than inside the workflow-policy file.
 */
test('the canonical npm test script keeps the trusted-bypass contract it is trusted for', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.match(scripts.test, /OPENBOOKS_TRUSTED_TEST_BYPASS=1/)
  assert.match(scripts.test, /NODE_ENV=test/)
})

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

/**
 * `npm test` and `npm run test:unit` used to carry two hand-copied lists of
 * static checks, and five checks ran under one entrypoint but not the other.
 * The list now lives once, in `check:static`; both entrypoints must start with
 * it and name no static check of their own.
 */
test('npm test and test:unit run the one shared static-check list', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.match(scripts['check:static'], /^npm run check:[a-z0-9-]+( && npm run check:[a-z0-9-]+)*$/)
  for (const name of ['test', 'test:unit']) {
    assert.ok(scripts[name].startsWith('npm run check:static && '), `${name} must start with the shared static-check list`)
    const own = [...scripts[name].matchAll(/npm run (check:[a-z0-9-]+)/g)].map((match) => match[1])
      .filter((check) => check !== 'check:static' && check !== 'check:security-jsx-copy')
    assert.deepEqual(own, [], `${name} names static checks outside check:static: ${own.join(', ')}`)
  }
})

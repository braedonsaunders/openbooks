import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditPublicSnapshot, isConnectorPath } from './check-product-neutrality.mjs'

/**
 * The neutrality gate decides which files may name an accounting vendor, so a
 * wrong decision there is silent either way: too strict and it blocks the
 * release train on legitimate regression tests, too loose and product copy
 * ships with vendor branding.
 *
 * Run 8bddf466-era evidence: `npm run check:product-neutrality` failed on
 * engine/src/{qbo,xero,odoo,erpnext}.test.ts because the connector allowlist
 * exact-matched only the implementation files, while the netsuite* prefix
 * already admitted its own tests. A connector's regression suite cannot be
 * forbidden to say which connector it exercises — naming the system under
 * test is the point of the test.
 *
 * These tests pin both edges: connector implementation AND test files stay
 * inside scope, everything else still fails the audit.
 */

/** Connector-named engine sources, keyed by what they cover. */
const CONNECTOR_TEST_FILES = [
  'engine/src/netsuite.test.ts',
  'engine/src/netsuite-bridge.test.ts',
  'engine/src/qbo.test.ts',
  'engine/src/xero.test.ts',
  'engine/src/odoo.test.ts',
  'engine/src/erpnext.test.ts',
  'engine/src/dynamics.test.ts',
]

const CONNECTOR_IMPLEMENTATION_FILES = [
  'engine/src/netsuite-golden.ts',
  'engine/src/qbo.ts',
  'engine/src/xero.ts',
  'engine/src/odoo.ts',
  'engine/src/erpnext.ts',
  'engine/src/dynamics.ts',
]

test('connector regression tests may name the connector they exercise', () => {
  const outside = CONNECTOR_TEST_FILES.filter((file) => !isConnectorPath(file))
  assert.deepEqual(
    outside,
    [],
    `these connector test files fell out of connector scope, so the neutrality gate blocks the release train on them:\n${outside.join('\n')}`,
  )
})

test('connector implementations keep their connector scope', () => {
  const outside = CONNECTOR_IMPLEMENTATION_FILES.filter((file) => !isConnectorPath(file))
  assert.deepEqual(outside, [])
})

test('connector scope is anchored, so product code cannot borrow a connector filename', () => {
  // The allowlist is per-directory, not substring-based: a web module named
  // after a connector must still fail, or vendor naming leaks into UI copy.
  assert.equal(isConnectorPath('web/lib/qbo.ts'), false)
  assert.equal(isConnectorPath('web/app/(app)/xero/page.tsx'), false)
  assert.equal(isConnectorPath('engine/src/erpnext-integration-guide.ts'), false)
  // The .test suffix is the only extension granted beyond the implementation,
  // so helper modules cannot ride along under a connector name.
  assert.equal(isConnectorPath('engine/src/qbo.helpers.ts'), false)
  assert.equal(isConnectorPath('engine/src/xero.test.tsx'), false)
})

test('the full audit accepts every tracked connector test file, including its vendor mentions', () => {
  const missing = [...CONNECTOR_TEST_FILES, ...CONNECTOR_IMPLEMENTATION_FILES]
    .filter((file) => !existsSync(file))
  assert.deepEqual(
    missing,
    [],
    `allowlisted connector files vanished; update CONNECTOR_*_FILES to the real surfaces:\n${missing.join('\n')}`,
  )
  assert.deepEqual(auditPublicSnapshot([...CONNECTOR_TEST_FILES, ...CONNECTOR_IMPLEMENTATION_FILES]), [])
})

test('the audit still rejects vendor names outside connector scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neutrality-audit-'))
  try {
    const vendorCopy = join(dir, 'close-checklist.md')
    writeFileSync(vendorCopy, '# Year-end close\n\nRun the NetSuite reconciliation first.\n')
    const cleanFile = join(dir, 'notes.md')
    writeFileSync(cleanFile, '# Close checklist\n\nReconcile every ledger account.\n')

    const violations = auditPublicSnapshot([vendorCopy, cleanFile])
    assert.deepEqual(violations, [
      `${vendorCopy}:3: accounting-vendor name outside connector scope`,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the audit rejects a vendor name in a non-connector path itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neutrality-audit-'))
  try {
    const vendorPath = join(dir, 'netsuite-migration.md')
    writeFileSync(vendorPath, 'Generic migration notes.\n')

    assert.deepEqual(auditPublicSnapshot([vendorPath]), [
      `${vendorPath}: accounting-vendor name in non-connector path`,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('compliance vendor matrix and drawer enforce subsidiary visibility', () => {
  assert.match(view, /loadComplianceMatrix\(\{[\s\S]*allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/)
  assert.match(view, /complianceSubsidiaryFilter\(sql`p\.subsidiary_id`, authz\.allowedSubsidiaryIds, \{ orgWideNull: true \}\)/)
  assert.match(view, /loadVendorCertificates\(orgId, openVendor, authz\.allowedSubsidiaryIds\)/)
  assert.match(view, /loadVendorWaivers\(orgId, openVendor, authz\.allowedSubsidiaryIds\)/)
  assert.match(view, /complianceSubsidiaryFilter\(sql`subsidiary_id`, authz\.allowedSubsidiaryIds, \{ orgWideNull: true \}\)/)
})

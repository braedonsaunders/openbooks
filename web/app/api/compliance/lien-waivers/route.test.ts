import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const collectionRoute = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')
const lifecycleRoute = readFileSync(fileURLToPath(new URL('./[id]/route.ts', import.meta.url)), 'utf8')
const complianceLoader = readFileSync(fileURLToPath(new URL('../../../../lib/compliance.ts', import.meta.url)), 'utf8')

describe('lien-waiver authorization boundaries', () => {
  it('carries the caller subsidiary scope through reads and writes', () => {
    assert.match(collectionRoute, /loadLienWaivers\(\{[\s\S]*allowedSubsidiaryIds: gate\.allowedSubsidiaryIds/)
    assert.match(collectionRoute, /complianceSubsidiaryFilter\(sql`p\.subsidiary_id`, gate\.allowedSubsidiaryIds/)
    assert.match(
      collectionRoute,
      /withOrgTransaction\(orgId, async \(\) => \{[\s\S]*insert into lien_waivers[\s\S]*insert into audit_log/
    )
  })
})

describe('lien-waiver lifecycle atomicity', () => {
  it('locks the scoped row before validating and auditing', () => {
    assert.match(lifecycleRoute, /withOrgTransaction\(orgId, async \(\) => \{/)
    assert.match(lifecycleRoute, /for update of lw/)
    assert.match(lifecycleRoute, /guardSubsidiaryScope\(\s*gate/)
    assert.match(lifecycleRoute, /update lien_waivers[\s\S]*insert into audit_log/)
  })
})

describe('compliance money arithmetic', () => {
  it('uses exact money arithmetic for blocked exposure', () => {
    assert.match(complianceLoader, /import \{ formatMoney, sum \} from/)
    assert.match(
      complianceLoader,
      /const blockedExposure = sum\([\s\S]*blocked\.filter\(\(b\) => b\.decision === ['"]blocked['"]\)/
    )
    assert.match(complianceLoader, /blockedExposure: formatMoney\(blockedExposure, 2\)/)
  })
})

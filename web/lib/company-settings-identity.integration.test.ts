import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Company & Accounting owns the company's legal identity: the registered
 * address, business structure and tax classification in org settings, and
 * the tax/registration identifiers in orgs.tax_ids. Writes validate against
 * the country the same save leaves the company in, refuse without writing,
 * and audit before/after state; the settings read the assistant uses
 * returns all of it.
 */
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { readCompanySettings, updateCompanySettings } = await import('./company-settings')

const skip = !process.env.OPENBOOKS_DB_URL

async function orgRow(orgId: string) {
  return withBypassContext(async () =>
    (await db.execute<{ tax_ids: Record<string, string>; settings: Record<string, unknown> }>(sql`
      select tax_ids, settings from orgs where id = ${orgId}`)).rows[0]!,
  )
}

test('legal identity persists canonically, reads back for the assistant, and is audited', { skip }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }
    const saved = await withBypassContext(() => updateCompanySettings(me, {
      country: 'US',
      address: { line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'us' },
      legalForm: 'llc',
      taxClassification: 'partnership',
      taxIds: { us_ein: '123456789' },
    }))
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const row = await orgRow(org.orgId)
    assert.deepEqual(row.tax_ids, { us_ein: '12-3456789' }, 'identifiers store in canonical form')
    assert.equal((row.settings.companyAddress as Record<string, string>).country, 'US')
    assert.equal(row.settings.legalForm, 'llc')
    assert.equal(row.settings.taxClassification, 'partnership')

    const view = await withBypassContext(() => readCompanySettings(org.orgId))
    const company = view.body.org as Record<string, unknown>
    assert.deepEqual(company.taxIds, { us_ein: '12-3456789' })
    assert.equal(company.legalForm, 'llc')
    assert.equal((company.address as Record<string, string>).city, 'Austin')

    const audits = await withBypassContext(async () =>
      (await db.execute<{ changes: Record<string, unknown> }>(sql`
        select changes from audit_log where org_id = ${org.orgId} and table_name = 'orgs' and action = 'update'`)).rows,
    )
    assert.ok(
      audits.some((entry) => JSON.stringify(entry.changes.taxIds) === JSON.stringify([{}, { us_ein: '12-3456789' }])),
      'the identifier change is audited with before and after',
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('malformed numbers, foreign schemes and impossible classifications refuse without writing', { skip }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }
    const before = await orgRow(org.orgId)

    const malformed = await withBypassContext(() => updateCompanySettings(me, { country: 'US', taxIds: { us_ein: '12-34' } }))
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.code, 'invalid-tax-id')
    assert.equal(malformed.body.scheme, 'us_ein')
    assert.match(String(malformed.body.error), /EIN is not a valid number — enter it like 12-3456789/)

    const foreign = await withBypassContext(() => updateCompanySettings(me, { country: 'US', taxIds: { ca_bn: '123456782' } }))
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.code, 'invalid-tax-id')
    assert.match(String(foreign.body.error), /not issued in US/)

    const sCorpAbroad = await withBypassContext(() =>
      updateCompanySettings(me, { country: 'CA', legalForm: 'corporation', taxClassification: 's_corporation' }))
    assert.equal(sCorpAbroad.status, 400)
    assert.equal(sCorpAbroad.body.code, 'tax-classification-mismatch')

    const partialAddress = await withBypassContext(() => updateCompanySettings(me, { address: { line1: '1 Main St' } }))
    assert.equal(partialAddress.status, 400)
    assert.equal(partialAddress.body.code, 'invalid-company-address')

    const after = await orgRow(org.orgId)
    assert.deepEqual(after.tax_ids, before.tax_ids, 'no refused save writes identifiers')
    assert.equal(after.settings.legalForm, before.settings.legalForm)
    assert.equal(after.settings.companyAddress, before.settings.companyAddress)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

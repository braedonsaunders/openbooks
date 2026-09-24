import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')
const { setupResource } = await import('../data-io/setup-resources.ts')

// A registration pairing a jurisdiction with another jurisdiction's form
// (a Canadian jurisdiction with US_NY_ST100) used to save: returnFormCode
// is free text with no write-time cross-check, and the return then printed
// the New York form with the Canadian number. The save now refuses the
// mismatched pair by name, with the remedy. Tenant-defined forms carry no
// catalog rule and still save.

async function seedJurisdiction(orgId: string, code: string): Promise<string> {
  const id = randomUUID()
  await withBypass(() => db.execute(sql`
    insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
    values (${id}, ${orgId}, ${code}, ${code}, 'XX', 'state', 'sales_use')`))
  return id
}

test('a cross-jurisdiction form pairing is refused at save', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  const asAdmin = { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> }
  try {
    const caId = await seedJurisdiction(org.orgId, 'CA')
    const refused = await withBypass(() => createSetupRecord(asAdmin, 'tax-registrations', {
      jurisdictionId: caId,
      registrationNumber: 'CA-REG-1',
      filingFrequency: 'quarterly',
      returnFormCode: 'US_NY_ST100',
      isActive: true,
    }))
    assert.equal(refused.status, 400)
    assert.match(String(refused.body.error), /CA-REG-1/)
    assert.match(String(refused.body.error), /"CA"/)
    assert.match(String(refused.body.error), /US_NY_ST100/)
    assert.match(String(refused.body.error), /US-NY/)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

test('the form-jurisdiction pairing saves, and a later remap to a foreign form is refused', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  const asAdmin = { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> }
  try {
    const nyId = await seedJurisdiction(org.orgId, 'US-NY')
    const created = await withBypass(() => createSetupRecord(asAdmin, 'tax-registrations', {
      jurisdictionId: nyId,
      registrationNumber: 'NY-REG-1',
      filingFrequency: 'quarterly',
      returnFormCode: 'US_NY_ST100',
      isActive: true,
    }))
    assert.equal(created.status, 200)
    const rowId = String((created.body as { id: string }).id)
    assert.ok(rowId, 'expected the created registration id back')
    // The drawer PATCHes the full row, so the remap carries every field.
    const remapped = await withBypass(() => updateSetupRecord(asAdmin, 'tax-registrations', {
      id: rowId,
      jurisdictionId: nyId,
      registrationNumber: 'NY-REG-1',
      filingFrequency: 'quarterly',
      returnFormCode: 'US_CA_CDTFA401',
      isActive: true,
    }))
    assert.equal(remapped.status, 400)
    assert.match(String(remapped.body.error), /US_CA_CDTFA401/)
    assert.match(String(remapped.body.error), /US-CA/)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

test('import/export descriptors leave the form code unresolved', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const registrations = SETUP_ENTITY_BY_KEY.get('tax-registrations')!
    const fields = await withBypass(() => setupResource(registrations, org.orgId).fields())
    const formCode = fields.find((f) => f.key === 'returnFormCode')
    assert.ok(formCode)
    assert.equal(formCode.kind, 'reference')
    // No ref target: the value round-trips as the code (export shows it,
    // import stores it) instead of resolving to a row id the engine can
    // never match. True references still resolve.
    assert.equal(formCode.ref, undefined)
    assert.ok(fields.find((f) => f.key === 'jurisdictionId')?.ref)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

test('a tenant-defined form saves on any jurisdiction', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  const asAdmin = { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> }
  try {
    const caId = await seedJurisdiction(org.orgId, 'CA')
    const created = await withBypass(() => createSetupRecord(asAdmin, 'tax-registrations', {
      jurisdictionId: caId,
      registrationNumber: 'CA-CUSTOM-1',
      filingFrequency: 'quarterly',
      returnFormCode: 'CUSTOM-PROBE',
      isActive: true,
    }))
    assert.equal(created.status, 200)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

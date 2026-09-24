import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The compliance vendor matrix, certificate drawer, and waiver drawer must
// enforce subsidiary visibility: an entity-restricted caller sees only their
// legal entities' vendors, never another entity's rows. (Was Vendors.scope
// source pins on the scope arguments.)
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') {
      return virtual('export function redirect(url){ throw new Error("REDIRECT:" + url) }')
    }
    return next(specifier, context)
  },
})

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import('@openbooks/engine/src/testing/fixtures.ts')
const {
  loadComplianceMatrix,
  loadVendorCertificates,
  loadVendorWaivers,
} = await import('../../../../lib/compliance')

const DB = !!process.env.OPENBOOKS_DB_URL

async function seedVendors() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Compliance reader', 'admin'))
  const hidden = randomUUID()
  const hiddenVendor = randomUUID()
  const classId = randomUUID()
  const requirementId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
    const kind = (
      await db.execute<{ kind: string }>(
        sql`select kind from parties where org_id = ${org.orgId} and id = ${org.vendorId}`,
      )
    ).rows[0]!.kind
    await db.execute(sql`
      insert into parties(id,org_id,kind,display_name,subsidiary_id)
      values (${hiddenVendor},${org.orgId},${kind},'Hidden Vendor',${hidden})`)
    await db.execute(sql`
      insert into compliance_classes
        (id, org_id, code, name, lien_waiver_enforcement, default_information_return, created_by, updated_by)
      values
        (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC', ${actor}, ${actor})`)
    for (const partyId of [org.vendorId, hiddenVendor]) {
      await db.execute(sql`
        insert into vendor_roles
          (org_id, party_id, compliance_class_id, information_return_form, information_return_box,
           tax_classification, tin_encrypted, tin_last4, tin_type, backup_withholding, is_t4a, created_by, updated_by)
        values
          (${org.orgId}, ${partyId}, ${classId}, '1099-MISC', '1', 'individual',
           'ciphertext', '9999', 'ssn', false, false, ${actor}, ${actor})`)
    }
    await db.execute(sql`
      insert into compliance_requirements
        (id, org_id, code, name, category, enforcement, requires_verification, created_by, updated_by)
      values
        (${requirementId}, ${org.orgId}, 'GL', 'General Liability', 'insurance', 'block_payment', false, ${actor}, ${actor})`)
    for (const partyId of [org.vendorId, hiddenVendor]) {
      await db.execute(sql`
        insert into compliance_records
          (org_id, party_id, requirement_id, status, effective_from, expires_on, created_by, updated_by)
        values
          (${org.orgId}, ${partyId}, ${requirementId}, 'active', '2026-01-01', '2026-12-31', ${actor}, ${actor})`)
    }
    await db.execute(sql`
      insert into compliance_waivers
        (org_id, party_id, requirement_id, reason, effective_from, expires_on)
      values
        (${org.orgId}, ${hiddenVendor}, ${requirementId}, 'owner form accepted', '2026-01-01', '2026-12-31')`)
  })
  return { org, hiddenVendor, requirementId }
}

test('the vendor matrix hides vendors outside the caller scope', { skip: !DB }, async () => {
  const { org, hiddenVendor } = await seedVendors()
  try {
    const scope = new Set([org.subsidiaryId])
    const partyIds = (await withBypassContext(() => loadComplianceMatrix({ orgId: org.orgId, allowedSubsidiaryIds: scope }))).rows.map(
      (row) => row.partyId,
    )
    assert.ok(partyIds.includes(org.vendorId), 'the caller entity vendor must list')
    assert.ok(!partyIds.includes(hiddenVendor), "another entity's vendor must not list")
    const all = (await withBypassContext(() => loadComplianceMatrix({ orgId: org.orgId, allowedSubsidiaryIds: null }))).rows.map(
      (row) => row.partyId,
    )
    assert.ok(all.includes(org.vendorId) && all.includes(hiddenVendor), 'an unrestricted matrix must list both vendors')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor certificates hide another entity vendor records', { skip: !DB }, async () => {
  const { org, hiddenVendor } = await seedVendors()
  try {
    const scope = new Set([org.subsidiaryId])
    const own = await withBypassContext(() => loadVendorCertificates(org.orgId, org.vendorId, scope))
    assert.equal(own.length, 1, 'the caller entity vendor record must load')
    assert.equal(
      (await withBypassContext(() => loadVendorCertificates(org.orgId, hiddenVendor, scope))).length,
      0,
      "another entity's vendor record must read as missing",
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor waivers hide another entity vendor rows', { skip: !DB }, async () => {
  const { org, hiddenVendor } = await seedVendors()
  try {
    const scope = new Set([org.subsidiaryId])
    assert.equal(
      (await withBypassContext(() => loadVendorWaivers(org.orgId, hiddenVendor, scope))).length,
      0,
      "another entity's waiver must read as missing",
    )
    const open = await withBypassContext(() => loadVendorWaivers(org.orgId, hiddenVendor, null))
    assert.equal(open.length, 1, 'an unrestricted waiver read must load the row')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

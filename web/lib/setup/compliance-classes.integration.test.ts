import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

// F-t03-007: creating a counterparty class with lien-waiver enforcement but
// no default waiver form 400'd with raw Postgres constraint text
// (`... violates check constraint "compliance_classes_waiver_type_required"`)
// on a form field that is not marked required. The refusal is now a typed
// user-language 400 preflighted at the API boundary (creates and edits
// alike), and the drawer marks the field required exactly while it applies.
async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"subcontractorCompliance": true}'::jsonb)
     where id = ${org.orgId}`))
  return { orgId: org.orgId, actorId }
}

function actor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: ['admin.setup.manage'] }
}

async function classCount(orgId: string): Promise<number> {
  const r = await withBypass(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from compliance_classes where org_id = ${orgId}`))
  return r.rows[0]!.n
}

test('the waiver-form field is required exactly while enforcement applies', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('compliance-classes')
  assert.ok(entity, 'compliance-classes is a registered setup entity')
  const field = entity.fields.find((f) => f.key === 'defaultLienWaiverType')
  assert.ok(field, 'the default waiver form is a declared field')
  assert.equal(field.required, true, 'the drawer marks the waiver form required')
  assert.deepEqual(
    field.showWhen,
    { field: 'lienWaiverEnforcement', in: ['warn', 'block'] },
    'required only while enforcement is Warn/Block — None keeps it hidden and optional',
  )
})

test('enforcement without a waiver form is a typed refusal, never raw SQL', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const before = await classCount(orgId)
    const result = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'compliance-classes', {
      code: 'SUB',
      name: 'Subcontractor',
      lienWaiverEnforcement: 'block',
      defaultInformationReturn: '1099-NEC',
    }))
    assert.equal(result.status, 400)
    const body = result.body as { error?: unknown; code?: unknown }
    assert.equal(body.code, 'invalid')
    // The drawer's errorMessage maps `<key> is required` through the field
    // label, so this key-style refusal renders as a localized field-level
    // message — exactly like client-side validate().
    assert.match(String(body.error ?? ''), /defaultLienWaiverType is required/)
    assert.doesNotMatch(
      String(body.error ?? ''),
      /violates check constraint|relation "compliance_classes"|new row for relation/,
      'no Postgres internals reach the user',
    )
    assert.equal(await classCount(orgId), before, 'the refused write persists nothing')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('enforcement with a waiver form — and unenforced classes — still save', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const enforced = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'compliance-classes', {
      code: 'SUB',
      name: 'Subcontractor',
      lienWaiverEnforcement: 'block',
      defaultLienWaiverType: 'conditional_progress',
      defaultInformationReturn: '1099-NEC',
    }))
    assert.equal(enforced.status, 200)
    const unenforced = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'compliance-classes', {
      code: 'GEN',
      name: 'General',
      lienWaiverEnforcement: 'none',
      defaultInformationReturn: 'none',
    }))
    assert.equal(unenforced.status, 200, 'enforcement None keeps the waiver form optional')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('touching another field on an enforced class keeps the stored waiver form', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const created = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'compliance-classes', {
      code: 'SUB',
      name: 'Subcontractor',
      lienWaiverEnforcement: 'block',
      defaultLienWaiverType: 'conditional_progress',
      defaultInformationReturn: '1099-NEC',
    }))
    assert.equal(created.status, 200)
    const id = (created.body as { id?: unknown }).id
    assert.ok(typeof id === 'string' && id.length > 0)
    // The waiver key is absent (and hidden against the partial body), so the
    // relaxation must leave the stored value alone — never write NULL over
    // an enforced row and trip the CHECK raw.
    const result = await withBypass(() => updateSetupRecord(actor(orgId, actorId), 'compliance-classes', {
      id,
      name: 'Subcontractor LLC',
    }))
    assert.equal(result.status, 200)
    const stored = await withBypass(() => db.execute<{ t: string | null }>(sql`
      select default_lien_waiver_type as t from compliance_classes where id = ${String(id)} and org_id = ${orgId}`))
    assert.equal(stored.rows[0]?.t, 'conditional_progress')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t04-013: the check From-account picker never persisted — pick a
// reconcilable bank, save clean, reopen shows '—'. The drawer sends
// custom.controlAccountId, but applyDocumentEdit rebuilds the custom bag
// from validateCustomValues' cleaned output (registered defs only), so the
// structural funding-bank override was silently dropped on every save.
// Only the round trip through the real PATCH proves the fix.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __fundingBankRoundTripState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__fundingBankRoundTripState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function can() { return true }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    // Pin the engine to THIS checkout (see route-recall for why).
    if (specifier.startsWith('@openbooks/engine/')) return next(root + specifier.slice('@openbooks/'.length), context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionCounterSql } = await import('../../../../lib/documents.ts')
const { PATCH } = await import('./route.ts')
// The route's web/lib chain re-registers the app RLS resolver at import
// time (see route-recall); re-install the test boundary after the imports.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/test-database-bypass.ts')
installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

async function revision(orgId: string, id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`)).rows[0]!.revision
}

async function patchDoc(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(orgId, () => PATCH(
    new Request(`http://documents.test/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ))
  return { status: response.status, json: await response.json().catch(() => null) }
}

async function storedCustom(orgId: string, id: string): Promise<Record<string, unknown>> {
  return (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from documents where id=${id} and org_id=${orgId}`)).rows[0]!.custom
}

async function fixture(): Promise<{ orgId: string; checkId: string; bankId: string; cleanup: () => Promise<void> }> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const bankId = randomUUID()
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${bankId}, ${org.orgId}, '1010', 'QA t04 Operating', 'asset_bank', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`)
  const checkId = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${checkId}, ${org.orgId}, 'check', 'draft', 'CHK-00001', ${org.date}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`)
  return { orgId: org.orgId, checkId, bankId, cleanup: () => dropScratchOrg(org.orgId) }
}

test('the funding-bank override round-trips through save and read-back', { skip: !DB }, async () => {
  const { orgId, checkId, bankId, cleanup } = await fixture()
  try {
    // Pick the bank and save: the override must persist on the custom bag.
    const saved = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: bankId },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal((await storedCustom(orgId, checkId)).controlAccountId, bankId)
    // Reopen (read-back) sees it, and re-saving other fields keeps it.
    const kept = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      memo: 'still the same bank',
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.equal((await storedCustom(orgId, checkId)).controlAccountId, bankId)
    // Switching banks persists the new override.
    const otherBankId = randomUUID()
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
      values (${otherBankId}, ${orgId}, '1020', 'Second Operating', 'asset_bank', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`)
    const switched = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: otherBankId },
    })
    assert.equal(switched.status, 200, JSON.stringify(switched.json))
    assert.equal((await storedCustom(orgId, checkId)).controlAccountId, otherBankId)
    // Clearing the picker falls back to the org default bank (key removed).
    const cleared = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: '' },
    })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
    assert.ok(!('controlAccountId' in (await storedCustom(orgId, checkId))), 'clearing the picker must remove the override')
  } finally {
    await cleanup()
  }
})

async function cardFixture(): Promise<{ orgId: string; chargeId: string; cardId: string; bankId: string; cleanup: () => Promise<void> }> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const cardId = randomUUID()
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${cardId}, ${org.orgId}, '2050', 'Corporate Credit Card', 'liability_card', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`)
  const bankId = randomUUID()
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${bankId}, ${org.orgId}, '1010', 'QA t04 Operating', 'asset_bank', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`)
  const chargeId = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${chargeId}, ${org.orgId}, 'card_charge', 'draft', 'CC-00001', ${org.date}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`)
  return { orgId: org.orgId, chargeId, cardId, bankId, cleanup: () => dropScratchOrg(org.orgId) }
}

// F-t05-020: with no card instruments on file the drawer offers the
// reconcilable card-liability account, saved as the controlAccountId
// override the engine cardRule already reads first. The guard must carry
// it exactly like the funding-bank override — and refuse the wrong
// population in both directions.
test('the card-liability override round-trips for card charges', { skip: !DB }, async () => {
  const { orgId, chargeId, cardId, cleanup } = await cardFixture()
  try {
    const saved = await patchDoc(orgId, chargeId, {
      expectedUpdatedAt: await revision(orgId, chargeId),
      custom: { controlAccountId: cardId },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal((await storedCustom(orgId, chargeId)).controlAccountId, cardId)
    const kept = await patchDoc(orgId, chargeId, {
      expectedUpdatedAt: await revision(orgId, chargeId),
      memo: 'still the same card',
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.equal((await storedCustom(orgId, chargeId)).controlAccountId, cardId)
    const cleared = await patchDoc(orgId, chargeId, {
      expectedUpdatedAt: await revision(orgId, chargeId),
      custom: { controlAccountId: '' },
    })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
    assert.ok(!('controlAccountId' in (await storedCustom(orgId, chargeId))), 'clearing the picker must remove the override')
  } finally {
    await cleanup()
  }
})

test('the card-liability override fails closed on the wrong population', { skip: !DB }, async () => {
  const { orgId, chargeId, cardId, bankId, cleanup } = await cardFixture()
  try {
    // A bank account is not a card liability, even when reconcilable.
    const bankOnCard = await patchDoc(orgId, chargeId, {
      expectedUpdatedAt: await revision(orgId, chargeId),
      custom: { controlAccountId: bankId },
    })
    assert.equal(bankOnCard.status, 404, JSON.stringify(bankOnCard.json))
    assert.ok(!('controlAccountId' in (await storedCustom(orgId, chargeId))), 'a refused override writes nothing')
    // A card liability is not a funding bank (same org, check draft).
    const checkId = randomUUID()
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${checkId}, ${orgId}, 'check', 'draft', 'CHK-00002', '2026-07-15', (select subsidiary_id from documents where id = ${chargeId}), 'CAD', '0', '0', '0', '{}'::jsonb)`)
    const cardOnCheck = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: cardId },
    })
    assert.equal(cardOnCheck.status, 404, JSON.stringify(cardOnCheck.json))
  } finally {
    await cleanup()
  }
})

test('the funding-bank override fails closed on foreign and malformed banks', { skip: !DB }, async () => {
  const { orgId, checkId, bankId, cleanup } = await fixture()
  try {
    const foreign = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: randomUUID() },
    })
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json))
    assert.ok(!('controlAccountId' in (await storedCustom(orgId, checkId))), 'a refused override writes nothing')
    const malformed = await patchDoc(orgId, checkId, {
      expectedUpdatedAt: await revision(orgId, checkId),
      custom: { controlAccountId: 'not-a-bank' },
    })
    assert.equal(malformed.status, 422, JSON.stringify(malformed.json))
    assert.ok(!('controlAccountId' in (await storedCustom(orgId, checkId))), 'a refused override writes nothing')
    void bankId
  } finally {
    await cleanup()
  }
})

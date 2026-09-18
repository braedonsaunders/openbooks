import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// documents/[id] PATCH forwards the generic edit body to the shared
// applyDocumentEdit service with no boundary validation of its own: a
// malformed documentDate/dueDate or a malformed reference id escapes as a
// raw Postgres throw (HTTP 500) instead of a domain 4xx, and a well-formed
// reference owned by another organization dies at the tenant-coherent FK as
// an unhandled 23503 (HTTP 500) instead of a tenant-opaque domain error.
// Only the session gate is stubbed; handler, service, and storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __documentEditBoundaryState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__documentEditBoundaryState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function can() { return true }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionCounterSql } = await import('../../../../lib/documents.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function makeDraftBill(org: { orgId: string; subsidiaryId: string; date: string; accounts: { cogs: string } }): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${'BILL-' + id.slice(0, 8)}, ${org.date}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`))
  return id
}

async function revision(orgId: string, id: string): Promise<string> {
  return (await withOrgContext(orgId, () => db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`))).rows[0]!.revision
}

async function patchDoc(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () => PATCH(
      new Request(`http://documents.test/api/documents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function storedDate(orgId: string, id: string): Promise<string> {
  return (await withOrgContext(orgId, () => db.execute<{ d: string }>(sql`select document_date::text as d from documents where id=${id} and org_id=${orgId}`))).rows[0]!.d
}

test('documents PATCH refuses a malformed document date with a domain error', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(org)
    const refused = await patchDoc(org.orgId, id, { expectedUpdatedAt: await revision(org.orgId, id), documentDate: 'not-a-date' })
    assert.ok(
      refused.status === 400 || refused.status === 422,
      `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(refused.json)}`,
    )
    const impossible = await patchDoc(org.orgId, id, { expectedUpdatedAt: await revision(org.orgId, id), documentDate: '2026-02-30' })
    assert.ok(
      impossible.status === 400 || impossible.status === 422,
      `expected a domain 4xx, got ${impossible.status}: ${JSON.stringify(impossible.json)}`,
    )
    assert.equal(await storedDate(org.orgId, id), org.date, 'refused dates write nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('documents PATCH refuses a malformed reference id with a domain error', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(org)
    const refused = await patchDoc(org.orgId, id, { expectedUpdatedAt: await revision(org.orgId, id), partyId: 'not-a-uuid' })
    assert.ok(
      refused.status === 400 || refused.status === 422,
      `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(refused.json)}`,
    )
    const stored = (await withOrgContext(org.orgId, () => db.execute<{ p: string | null }>(sql`select party_id as p from documents where id=${id} and org_id=${org.orgId}`))).rows[0]!.p
    assert.equal(stored, null, 'refused references write nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('documents PATCH refuses malformed and foreign line dimension references', { skip: !DB }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg())
  const orgB = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = orgA.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(orgA)
    const deptB = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into departments (id, org_id, name) values (${deptB}, ${orgB.orgId}, 'Foreign department')`))
    const line = (departmentId: string) => ({ accountId: orgA.accounts.cogs, amount: '10', description: 'probe', departmentId })
    const malformed = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), lines: [line('not-a-uuid')] })
    assert.equal(malformed.status, 422, `expected 422, got ${malformed.status}: ${JSON.stringify(malformed.json)}`)
    const foreign = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), lines: [line(deptB)] })
    assert.equal(foreign.status, 404, `expected 404, got ${foreign.status}: ${JSON.stringify(foreign.json)}`)
    const lines = (await withOrgContext(orgA.orgId, () => db.execute<{ n: number }>(sql`select count(*)::int as n from document_lines where document_id=${id} and org_id=${orgA.orgId}`))).rows[0]!.n
    assert.equal(lines, 0, 'refused line references store nothing')
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('documents PATCH refuses a foreign-organization party with a tenant-opaque domain error', { skip: !DB }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg())
  const orgB = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = orgA.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(orgA)
    // orgB's real vendor: well-formed, but another tenant's. The composite
    // FK refuses it at storage; the boundary must translate that into a
    // domain 404/422 instead of a raw 500.
    const refused = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), partyId: orgB.vendorId })
    assert.ok(
      refused.status === 404 || refused.status === 422,
      `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(refused.json)}`,
    )
    const stored = (await withOrgContext(orgA.orgId, () => db.execute<{ p: string | null }>(sql`select party_id as p from documents where id=${id} and org_id=${orgA.orgId}`))).rows[0]!.p
    assert.equal(stored, null, 'refused foreign references store nothing')
    // An own-org party still saves.
    const saved = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), partyId: orgA.vendorId })
    assert.equal(saved.status, 200, `own-org party must stay green: ${JSON.stringify(saved.json)}`)
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('documents PATCH refuses foreign reference custom values on header and lines', { skip: !DB }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg())
  const orgB = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = orgA.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(orgA)
    await withBypassContext(() => db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${orgA.orgId}, 'documents', 'vendor_bill', 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${state.actorId}, ${state.actorId}),
        (${randomUUID()}, ${orgA.orgId}, 'document_lines', 'vendor_bill', 'line_ref', 'Line reference', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${state.actorId}, ${state.actorId})
    `))
    // Header: a foreign-org party id is well-formed but another tenant's.
    const refusedHeader = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), custom: { ref_party: orgB.vendorId } })
    assert.equal(refusedHeader.status, 404, `expected tenant-opaque 404, got ${refusedHeader.status}: ${JSON.stringify(refusedHeader.json)}`)
    const storedCustom = (await withOrgContext(orgA.orgId, () => db.execute<{ custom: Record<string, unknown> }>(sql`select custom from documents where id=${id} and org_id=${orgA.orgId}`))).rows[0]!.custom
    assert.equal(storedCustom?.ref_party, undefined, 'refused header references store nothing')
    // An own-org reference still saves.
    const savedHeader = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), custom: { ref_party: orgA.vendorId } })
    assert.equal(savedHeader.status, 200, `own-org header reference must stay green: ${JSON.stringify(savedHeader.json)}`)
    // Lines: same fence, naming the offending line.
    const line = (ref: string) => ({ accountId: orgA.accounts.cogs, amount: '10', description: 'probe', custom: { line_ref: ref } })
    const refusedLine = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), lines: [line(orgB.vendorId)] })
    assert.equal(refusedLine.status, 404, `expected tenant-opaque 404, got ${refusedLine.status}: ${JSON.stringify(refusedLine.json)}`)
    const lines = (await withOrgContext(orgA.orgId, () => db.execute<{ n: number }>(sql`select count(*)::int as n from document_lines where document_id=${id} and org_id=${orgA.orgId}`))).rows[0]!.n
    assert.equal(lines, 0, 'refused line references store nothing')
    const savedLine = await patchDoc(orgA.orgId, id, { expectedUpdatedAt: await revision(orgA.orgId, id), lines: [line(orgA.vendorId)] })
    assert.equal(savedLine.status, 200, `own-org line reference must stay green: ${JSON.stringify(savedLine.json)}`)
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})



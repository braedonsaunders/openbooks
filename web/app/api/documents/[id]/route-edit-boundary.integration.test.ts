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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionSql } = await import('../../../../lib/documents.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function makeDraftBill(org: { orgId: string; subsidiaryId: string; date: string }): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${'BILL-' + id.slice(0, 8)}, ${org.date}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`)
  return id
}

async function revision(orgId: string, id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from documents where id=${id} and org_id=${orgId}`)).rows[0]!.revision
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
  return (await db.execute<{ d: string }>(sql`select document_date::text as d from documents where id=${id} and org_id=${orgId}`)).rows[0]!.d
}

test('documents PATCH refuses a malformed document date with a domain error', { skip: !DB }, async () => {
  const org = await createScratchOrg()
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
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftBill(org)
    const refused = await patchDoc(org.orgId, id, { expectedUpdatedAt: await revision(org.orgId, id), partyId: 'not-a-uuid' })
    assert.ok(
      refused.status === 400 || refused.status === 422,
      `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(refused.json)}`,
    )
    const stored = (await db.execute<{ p: string | null }>(sql`select party_id as p from documents where id=${id} and org_id=${org.orgId}`)).rows[0]!.p
    assert.equal(stored, null, 'refused references write nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})



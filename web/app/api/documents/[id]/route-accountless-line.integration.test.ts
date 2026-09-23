import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// OM-09: a PATCH whose lines contain a contentful row without an account
// (Sara's OPS-W01 x2 @100 line) must fail closed with a 422 naming the
// line — and must change nothing: the invoice total and its stored lines
// stay exactly as they were. Only the session gate is stubbed; handler,
// service, and storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __documentAccountlessLineState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__documentAccountlessLineState;
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
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import("../../../../../engine/src/records/revision.ts");
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function makeDraftInvoice(org: { orgId: string; subsidiaryId: string; date: string }): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${'INV-' + id.slice(0, 8)}, ${org.date}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`))
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

async function storedTotals(orgId: string, id: string): Promise<{ total: string; subtotal: string; lines: { n: number; amounts: string[] } }> {
  const doc = (await withOrgContext(orgId, () => db.execute<{ total: string; subtotal: string }>(sql`select total::text as total, subtotal::text as subtotal from documents where id=${id} and org_id=${orgId}`))).rows[0]!
  const lines = (await withOrgContext(orgId, () => db.execute<{ amount: string }>(sql`select amount::text as amount from document_lines where document_id=${id} and org_id=${orgId} order by line_number`))).rows
  return { total: doc.total, subtotal: doc.subtotal, lines: { n: lines.length, amounts: lines.map((l) => l.amount) } }
}

test('documents PATCH refuses an account-less contentful line with its line number and writes nothing', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftInvoice(org)
    // Book line 1 at 1,480 through the route itself.
    const booked = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [{ accountId: org.accounts.revenue, amount: '1480', description: 'booked' }],
    })
    assert.equal(booked.status, 200, `booking line 1 should succeed, got ${booked.status}: ${JSON.stringify(booked.json)}`)
    assert.deepEqual(await storedTotals(org.orgId, id), {
      total: '1480.0000',
      subtotal: '1480.0000',
      lines: { n: 1, amounts: ['1480.0000'] },
    })
    // Sara's added line: service item, qty 2 x 100, amount derived —
    // but no income account.
    const refused = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [
        { accountId: org.accounts.revenue, amount: '1480', description: 'booked' },
        { accountId: '', itemId: org.items.service, description: 'field work', quantity: '2', unitPrice: '100', amount: '200' },
      ],
    })
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.json)}`)
    assert.match(
      String((refused.json as { error?: unknown } | null)?.error ?? ''),
      /Line 2: an account is required/,
      'the refusal must name the offending line and the remedy',
    )
    // Nothing persisted: the invoice is still one line at 1,480.
    assert.deepEqual(await storedTotals(org.orgId, id), {
      total: '1480.0000',
      subtotal: '1480.0000',
      lines: { n: 1, amounts: ['1480.0000'] },
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

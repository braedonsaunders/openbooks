import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// The platform-connections [id] family resolves the path id without gating
// it: PATCH/DELETE/run/test/qwc bind it straight into the connection lookup
// and a malformed id escapes as a raw Postgres uuid throw (HTTP 500) instead
// of the same 404 an unknown id returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __platformConnIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const AUTHZ = `
  export async function guardPermission() {
    const s = globalThis.__platformConnIdState;
    return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
  }
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.endsWith('/lib/authz')) return virtual(AUTHZ)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { sql } = await import('drizzle-orm')
const { PATCH, DELETE } = await import('./route.ts')
const { POST: runPost } = await import('./run/route.ts')
const { POST: testPost } = await import('./test/route.ts')
const { GET: qwcGet } = await import('./qwc/route.ts')
const { POST: deletionsPost } = await import('./source-deletions/[ref]/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string; ref: string }> }) => Promise<Response>

async function call(handler: Handler, method: string, params: { id: string; ref?: string }, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  try {
    const response = await withOrgContext(state.orgId, () => handler(
      new Request('http://platform.test/api/platform/connections/x', init),
      { params: Promise.resolve({ id: params.id, ref: params.ref ?? '' }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

const MALFORMED = 'not-a-uuid'

test('PATCH returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(PATCH, 'PATCH', { id: MALFORMED }, {})
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('DELETE returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(DELETE, 'DELETE', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('run returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(runPost, 'POST', { id: MALFORMED }, { mode: 'mirror' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('test returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(testPost, 'POST', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('qwc returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(qwcGet, 'GET', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('source-deletions returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(deletionsPost, 'POST', { id: MALFORMED, ref: 'x' }, { action: 'retain' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('source-deletions binds void/retain to the path connection and the already-decoded ref', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    state.actorId = await createScratchUser(org.orgId, 'Source deletion route controller', 'admin')
    const pathConnection = randomUUID()
    const otherConnection = randomUUID()
    const pathDocument = randomUUID()
    const otherDocument = randomUUID()
    const sourceRef = 'INV-100%25OFF'
    await db.execute(sql`
      insert into connections
        (id, org_id, source, display_name, status)
      values
        (${pathConnection}, ${org.orgId}, 'qbo', 'Path connection', 'active'),
        (${otherConnection}, ${org.orgId}, 'qbo', 'Other connection', 'active')`)
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, currency,
         subtotal, tax_total, total, custom)
      values
        (
          ${pathDocument}, ${org.orgId}, 'sales_order', 'approved',
          'SO-PATH-REF', ${org.date}, 'CAD', '25', '0', '25',
          ${JSON.stringify({ qboId: sourceRef, connectionId: pathConnection })}::jsonb
        ),
        (
          ${otherDocument}, ${org.orgId}, 'sales_order', 'approved',
          'SO-OTHER-REF', ${org.date}, 'CAD', '30', '0', '30',
          ${JSON.stringify({ qboId: sourceRef, connectionId: otherConnection })}::jsonb
        )`)

    const retained = await call(
      deletionsPost,
      'POST',
      { id: pathConnection, ref: sourceRef },
      { action: 'retain' },
    )
    assert.equal(retained.status, 200, JSON.stringify(retained.json))
    assert.deepEqual(retained.json, {
      ok: true,
      documentId: pathDocument,
      action: 'retain',
      reversalEntryId: null,
    })

    const voided = await call(
      deletionsPost,
      'POST',
      { id: otherConnection, ref: sourceRef },
      { action: 'void' },
    )
    assert.equal(voided.status, 200, JSON.stringify(voided.json))
    assert.deepEqual(voided.json, {
      ok: true,
      documentId: otherDocument,
      action: 'void',
      reversalEntryId: null,
    })

    const statuses = (
      await db.execute<{ id: string; status: string }>(sql`
        select id, status
          from documents
         where org_id = ${org.orgId}
           and id in (${pathDocument}, ${otherDocument})
         order by document_number
      `)
    ).rows
    assert.deepEqual(statuses, [
      { id: otherDocument, status: 'voided' },
      { id: pathDocument, status: 'approved' },
    ])

    const barePercentRef = '100%'
    const percentDocument = randomUUID()
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, currency,
         subtotal, tax_total, total, custom)
      values (
        ${percentDocument}, ${org.orgId}, 'sales_order', 'approved',
        'SO-PERCENT-REF', ${org.date}, 'CAD', '10', '0', '10',
        ${JSON.stringify({ qboId: barePercentRef, connectionId: pathConnection })}::jsonb
      )`)
    const percent = await call(
      deletionsPost,
      'POST',
      { id: pathConnection, ref: barePercentRef },
      { action: 'retain' },
    )
    assert.equal(percent.status, 200, JSON.stringify(percent.json))
    assert.equal(
      (percent.json as { documentId?: string }).documentId,
      percentDocument,
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown ids still return the not-found contract', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const patched = await call(PATCH, 'PATCH', { id: randomUUID() }, {})
    assert.equal(patched.status, 404, JSON.stringify(patched.json))
    const ran = await call(runPost, 'POST', { id: randomUUID() }, { mode: 'mirror' })
    assert.equal(ran.status, 404, JSON.stringify(ran.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

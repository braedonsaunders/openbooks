import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Exercise the action endpoint through real journal creation and posting. The
// session is the only boundary stubbed; journal lifecycle, posting, and the
// warning query all use the real local test database.
const stateKey = Symbol.for('openbooks.journal-actions-warning-test')
interface RouteState {
  authz: { user: { orgId: string; id: string }; permissions: Set<string>; allowedSubsidiaryIds: string[] | null } | null
}
const routeState: RouteState = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.journal-actions-warning-test')]
  export async function guardPermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() { return null }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '../../../../lib/authz' || specifier === '../../../lib/authz') {
      return { url: 'mock:journal-actions-authz', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const parentDir = decodeURIComponent(new URL('.', context.parentURL).href)
      const webRoot = parentDir.lastIndexOf('/web/')
      if (webRoot === -1) return nextResolve(specifier, context)
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + '.ts').href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:journal-actions-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { POST: createJournal } = await import('../route.ts')
const { POST: postJournal } = await import('./route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)

test('posting a partyless control leg returns its typed warning with the entry id', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId))
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId },
      permissions: new Set(['gl.post']),
      allowedSubsidiaryIds: null,
    }

    const documentId = randomUUID()
    const createResponse = await withOrgContext(org.orgId, () => createJournal(new Request('http://localhost/api/journals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': documentId },
      body: JSON.stringify({
        documentDate: '2026-07-14',
        lines: [
          { accountId: org.accounts.ar, amount: '100', description: 'partyless receivable control' },
          { accountId: org.accounts.revenue, amount: '-100', description: 'revenue offset' },
        ],
      }),
    })))
    assert.equal(createResponse.status, 201, await createResponse.text())

    const response = await withOrgContext(org.orgId, () => postJournal(new Request('http://localhost/api/journals/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'post', documentId }),
    })))
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      ok?: boolean
      entryId?: string
      warnings?: Array<{ code?: string; accounts?: Array<{ accountName?: string; accountNumber?: string; amount?: string }> }>
    }
    assert.equal(body.ok, true)
    assert.ok(body.entryId)
    assert.equal(body.warnings?.length, 1)
    assert.equal(body.warnings?.[0]?.code, 'partyless_control_lines')
    assert.deepEqual(body.warnings?.[0]?.accounts?.map(({ accountNumber, accountName, amount }) => ({ accountNumber, accountName, amount })), [
      { accountNumber: '1100', accountName: 'Accounts Receivable', amount: '100.0000' },
    ])

    const posted = await withOrgContext(org.orgId, () => db.execute<{ status: string }>(sql`
      select status from documents where id = ${documentId} and org_id = ${org.orgId}
    `))
    assert.equal(posted.rows[0]?.status, 'posted', 'warning communicates the exposure without refusing legitimate GL posting')
  } finally {
    routeState.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

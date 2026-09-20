/**
 * An account typed asset_bank shows as cash everywhere, so the product warns
 * (never refuses) when the typing is uncorroborated — no bank-like name, not
 * statement-reconcilable, no statements behind it. The warning must surface
 * at every write surface: account create, account update, and the accounts
 * import (preview and commit alike).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.account-warnings-test')
interface HarnessState {
  authz: { user: { orgId: string; id: string } } | null
}
const harnessState: HarnessState = { authz: null }
;(globalThis as Record<symbol, unknown>)[stateKey] = harnessState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.account-warnings-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../lib/authz' || specifier === '../../../../lib/authz') {
      return { url: 'mock:authz', shortCircuit: true }
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
    if (url === 'mock:authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const { POST } = (await import(`../route.ts?account-warnings-${Date.now()}`)) as typeof import(
  '../route.ts'
)
const { PATCH } = (await import(`../[id]/route.ts?account-warnings-${Date.now()}`)) as typeof import(
  '../[id]/route.ts'
)
const { MASTER_BY_KEY, masterResource } = (await import(
  `../../../../lib/data-io/master-data-resources.ts?account-warnings-${Date.now()}`
)) as typeof import('../../../../lib/data-io/master-data-resources.ts')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

async function org(): Promise<{ orgId: string; actorId: string }> {
  const o = await createScratchOrg()
  const { adminId } = await seedFlowActors(o.orgId)
  harnessState.authz = { user: { orgId: o.orgId, id: adminId } }
  return { orgId: o.orgId, actorId: adminId }
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  })
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const patchParams = (id: string) => ({ params: Promise.resolve({ id }) })

test(
  'creating an uncorroborated asset_bank warns but still creates',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { orgId } = await org()
    try {
      const res = await POST(postRequest({ name: 'Provision for Future Income Tax', type: 'asset_bank' }))
      assert.equal(res.status, 201)
      const body = (await res.json()) as { account: { id: string }; warnings: string[] }
      assert.ok(body.account?.id, 'the account is created — a warning is not a refusal')
      assert.equal(body.warnings?.length, 1)
      assert.match(body.warnings[0]!, /Provision for Future Income Tax/)

      const clean = await POST(postRequest({ name: 'RBC Bank', type: 'asset_bank' }))
      assert.equal(clean.status, 201)
      assert.deepEqual((await clean.json() as { warnings: string[] }).warnings, [])
    } finally {
      harnessState.authz = null
      await dropScratchOrg(orgId)
    }
  },
)

test(
  'updating an account into an uncorroborated asset_bank warns',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { orgId } = await org()
    try {
      const created = (await (
        await POST(postRequest({ name: 'Operating Cash', type: 'asset_other' }))
      ).json()) as { account: { id: string } }
      const id = created.account.id

      const renamed = await PATCH(patchRequest(id, { type: 'asset_bank', name: 'Operating' }), patchParams(id))
      assert.equal(renamed.status, 200)
      const renamedBody = (await renamed.json()) as { warnings: string[] }
      assert.equal(renamedBody.warnings?.length, 1)
      assert.match(renamedBody.warnings[0]!, /Operating/)

      const fixed = await PATCH(patchRequest(id, { name: 'Operating Bank' }), patchParams(id))
      assert.equal(fixed.status, 200)
      assert.deepEqual((await fixed.json() as { warnings: string[] }).warnings, [])
    } finally {
      harnessState.authz = null
      await dropScratchOrg(orgId)
    }
  },
)

test(
  'importing accounts carries the warning in the outcome, preview included',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { orgId, actorId } = await org()
    try {
      const master = MASTER_BY_KEY.get('accounts')
      assert.ok(master)
      const resource = masterResource(master, orgId)
      const rows = [
        { number: '1190', name: 'Payroll Clearing', type: 'asset_bank' },
        { number: '1001', name: 'RBC Bank', type: 'asset_bank' },
      ]
      for (const dryRun of [true, false]) {
        const outcome = await resource.write(rows, 'insert', { orgId, actorId, dryRun })
        assert.deepEqual(
          { created: outcome.created, updated: outcome.updated, failed: outcome.failed },
          { created: 2, updated: 0, failed: 0 },
          `dryRun=${dryRun}`,
        )
        assert.deepEqual(
          (outcome.warnings ?? []).map((w) => w.row),
          [1],
          `dryRun=${dryRun}: only the clearing row warns`,
        )
        assert.match(outcome.warnings?.[0]?.message ?? '', /Payroll Clearing/)
      }
      const stored = (
        await db.execute<{ number: string }>(sql`
          select number from accounts where org_id = ${orgId} and number in ('1190', '1001')`)
      ).rows.map((r) => r.number).sort()
      assert.deepEqual(stored, ['1001', '1190'], 'a warning never blocks the write')
    } finally {
      harnessState.authz = null
      await dropScratchOrg(orgId)
    }
  },
)

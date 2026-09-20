import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const STATE_KEY = Symbol.for('openbooks.assistant-commit-scope-test')

interface CommitState {
  authz: {
    user: Record<string, unknown>
    permissions: Set<string>
    allowedSubsidiaryIds: Set<string> | null
  } | null
}

const commitState: CommitState = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[STATE_KEY] = commitState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.assistant-commit-scope-test')]
      export async function guardPermission() {
        return state.authz
      }
      export function can(authz, perm) {
        return authz.permissions.has(perm)
      }
    `,
  ],
  [
    'mock:proposals',
    `
      export function verifyProposal() {
        return true
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['../authz', 'mock:authz'],
  ['../../../../lib/assistant/proposals', 'mock:proposals'],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { env } = await import('@openbooks/engine/src/platform/db.ts')

const DB = !!env.OPENBOOKS_DB_URL

/**
 * Through-stack proofs that the assistant commit boundary books drafts under
 * the caller's subsidiary scope exactly like POST /api/journals/draft: a
 * restricted caller lands in their single visible entity (never root), an
 * empty or ambiguous scope is refused before anything is written, and an
 * unrestricted caller keeps the existing root behavior.
 */

const { POST } = await import('./route.ts')

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  childSub: string
}

async function makeFixture(): Promise<Fixture> {
  const org = await withBypass(async () => {
    const created = await createScratchOrg()
    const { seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
    return { created, actors: await seedFlowActors(created.orgId) }
  })
  const childSub = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${childSub}, ${org.created.orgId}, ${org.created.subsidiaryId}, 'Branch Co', 'CAD', 'CA')`)
  })
  return { org: org.created, actorId: org.actors.adminId, childSub }
}

function authzFor(fx: Fixture, allowed: Set<string> | null): CommitState['authz'] {
  return {
    user: {
      id: fx.actorId,
      email: 'commit-scope@scratch.test',
      name: 'Commit Scope Caller',
      roles: [],
      orgId: fx.org.orgId,
      envKind: 'production',
      productionOrgId: fx.org.orgId,
      isSuperAdmin: false,
      homeUserId: fx.actorId,
      homeOrgId: fx.org.orgId,
    },
    permissions: new Set(['assistant.write', 'gl.post']),
    allowedSubsidiaryIds: allowed,
  }
}

function commitBody(fx: Fixture) {
  return {
    kind: 'create_journal_entry',
    preview: {
      documentDate: fx.org.date,
      memo: 'commit scope probe',
      lines: [
        { accountId: fx.org.accounts.bank, description: null, amount: '10.00' },
        { accountId: fx.org.accounts.revenue, description: null, amount: '-10.00' },
      ],
    },
    confirmToken: `scope-probe-${randomUUID()}`,
  }
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/assistant/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  ) as unknown as Promise<Response>
}

async function journalDrafts(orgId: string): Promise<{ id: string; subsidiary_id: string }[]> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string; subsidiary_id: string }>(sql`
        select id, subsidiary_id from documents
         where org_id = ${orgId} and kind = 'journal' order by created_at`),
    )
  ).rows
}

test(
  'a restricted commit lands in the single visible subsidiary, never root',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx, new Set([fx.childSub]))
      const response = await post(commitBody(fx))
      assert.equal(response.status, 200)
      const drafts = await journalDrafts(fx.org.orgId)
      assert.equal(drafts.length, 1)
      assert.equal(drafts[0]!.subsidiary_id, fx.childSub)
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'an unrestricted commit keeps the existing root behavior',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx, null)
      const response = await post(commitBody(fx))
      assert.equal(response.status, 200)
      const drafts = await journalDrafts(fx.org.orgId)
      assert.equal(drafts.length, 1)
      assert.equal(drafts[0]!.subsidiary_id, fx.org.subsidiaryId)
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'a signed preview with an impossible document date fails closed instead of a storage 500',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx, null)
      // Proposal verification is stubbed to accept: the HMAC covers preview
      // integrity, not calendar semantics, so a model-emitted impossible day
      // reaches the write boundary and must fail closed there.
      const body = commitBody(fx)
      body.preview.documentDate = '2026-02-30'
      let status: number
      let payload: unknown = null
      try {
        const response = await post(body)
        status = response.status
        payload = await response.json().catch(() => null)
      } catch {
        status = 500
      }
      assert.ok(
        status === 400 || status === 422,
        `expected a domain 4xx, got ${status}: ${JSON.stringify(payload)}`,
      )
      assert.deepEqual(await journalDrafts(fx.org.orgId), [], 'refused dates write nothing')
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'an empty or ambiguous restricted scope is refused before anything is written',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx, new Set())
      const empty = await post(commitBody(fx))
      assert.equal(empty.status, 409)
      commitState.authz = authzFor(fx, new Set([fx.org.subsidiaryId, fx.childSub]))
      const ambiguous = await post(commitBody(fx))
      assert.equal(ambiguous.status, 409)
      assert.deepEqual(await journalDrafts(fx.org.orgId), [])
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

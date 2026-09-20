import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

/**
 * Assistant commit shape-checks draft line amounts (4dp) but never fences
 * whole-digit width — so a balanced pair of pasted 20-digit lines sails
 * through the balance check and dies in Postgres on the journal draft
 * insert, throwing the raw driver failure out of the route (an unhandled
 * 500) instead of failing closed with a named 422 and nothing written.
 * documents subtotal/total and document_lines amount are numeric(19,4).
 */
const STATE_KEY = Symbol.for('openbooks.assistant-commit-bounds-test')

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
      const state = globalThis[Symbol.for('openbooks.assistant-commit-bounds-test')]
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

const { db, withBypass, withOrgContext, env } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const DB = !!env.OPENBOOKS_DB_URL
const { POST } = await import('./route.ts')

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
}

async function makeFixture(): Promise<Fixture> {
  const org = await withBypass(async () => {
    const created = await createScratchOrg()
    const { seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
    return { created, actors: await seedFlowActors(created.orgId) }
  })
  return { org: org.created, actorId: org.actors.adminId }
}

function authzFor(fx: Fixture): CommitState['authz'] {
  return {
    user: {
      id: fx.actorId,
      email: 'commit-bounds@scratch.test',
      name: 'Commit Bounds Caller',
      roles: [],
      orgId: fx.org.orgId,
      envKind: 'production',
      productionOrgId: fx.org.orgId,
      isSuperAdmin: false,
      homeUserId: fx.actorId,
      homeOrgId: fx.org.orgId,
    },
    permissions: new Set(['assistant.write', 'gl.post']),
    allowedSubsidiaryIds: null,
  }
}

function commitBody(fx: Fixture, amount: string) {
  return {
    kind: 'create_journal_entry',
    preview: {
      documentDate: fx.org.date,
      memo: 'commit bounds probe',
      lines: [
        { accountId: fx.org.accounts.bank, description: null, amount },
        { accountId: fx.org.accounts.revenue, description: null, amount: `-${amount}` },
      ],
    },
    confirmToken: `bounds-probe-${randomUUID()}`,
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

async function journalCount(orgId: string): Promise<number> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${orgId} and kind = 'journal'`),
    )
  ).rows[0]!.n
}

test(
  'commit refuses balanced lines wider than numeric(19,4) without writing',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx)
      const response = await post(commitBody(fx, '99999999999999999999.99'));
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
      assert.doesNotMatch(json?.error ?? '', /numeric field overflow|Failed query/i);
      assert.equal(await journalCount(fx.org.orgId), 0)
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'commit still drafts ordinary balanced lines',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      commitState.authz = authzFor(fx)
      const response = await post(commitBody(fx, '10.00'))
      assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)))
      assert.equal(await journalCount(fx.org.orgId), 1)
    } finally {
      commitState.authz = null
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

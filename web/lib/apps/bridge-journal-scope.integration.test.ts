import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { installApp, runBridgeMethod } = await import('./store')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

const DB = !!env.OPENBOOKS_DB_URL

/**
 * Regression coverage (X1, App bridge path): runBridgeMethod received the
 * caller's allowedSubsidiaryIds but the journal adapter dropped it, so an App
 * backend run by a restricted user always drafted/posted into the ROOT entity.
 * The adapter now carries the scope into createScriptJournal, which applies
 * the HTTP draft route's decision table.
 */

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  childId: string
  user: Parameters<typeof runBridgeMethod>[0]['user']
}

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg()
    const { adminId } = await seedFlowActors(org.orgId)
    const childId = randomUUID()
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Child entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`)
    const user = {
      id: adminId,
      email: 'scope@scratch.test',
      name: 'Scoped Caller',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: adminId,
      homeOrgId: org.orgId,
    }
    return { org, actorId: adminId, childId, user }
  })
}

const HANDLER = `function handler(request) {
  var input = {
    documentDate: request.body.documentDate,
    memo: 'bridge scope proof',
    lines: [
      { accountCode: '1000', amount: request.body.amount },
      { accountCode: '5000', amount: -request.body.amount }
    ]
  };
  if (request.body.subsidiaryId) input.subsidiaryId = request.body.subsidiaryId;
  var j = ob.journal.create(input, { post: !!request.body.post });
  return { journal: j.documentNumber, posted: j.entryId !== undefined };
}
`

async function installScopeApp(fx: Fixture): Promise<string> {
  const key = `scopeproof-${randomUUID().slice(0, 8)}`
  await withBypass(() =>
    installApp(fx.org.orgId, fx.actorId, {
      manifest: {
        key,
        name: 'Scope Proof App',
        version: '1.0.0',
        description: '',
        permissions: ['gl.post'],
        frontend: { entry: 'frontend/index.html' },
        endpoints: [{ name: 'journal', file: 'backend/journal.js', method: 'POST' }],
      },
      files: [
        { path: 'frontend/index.html', content: '<html><body>proof</body></html>' },
        { path: 'backend/journal.js', content: HANDLER },
      ],
    }),
  )
  return key
}

function callBridge(
  fx: Fixture,
  appKey: string,
  body: Record<string, unknown>,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): ReturnType<typeof runBridgeMethod> {
  return runBridgeMethod({
    orgId: fx.org.orgId,
    user: fx.user,
    key: appKey,
    method: 'callBackend',
    payload: { endpoint: 'journal', payload: body },
    userCan: () => true,
    allowedSubsidiaryIds,
  })
}

async function journalSubsidiaries(orgId: string): Promise<string[]> {
  const r = await withOrgContext(orgId, () =>
    db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text from documents where org_id = ${orgId} and kind = 'journal' order by created_at`),
  )
  return r.rows.map((row) => row.subsidiary_id)
}

test('a bridge caller restricted to a child entity journals into that entity, never the root', { skip: !DB }, async () => {
  const fx = await makeFixture()
  try {
    const appKey = await installScopeApp(fx)
    const scope = new Set([fx.childId])

    const posted = await callBridge(fx, appKey, { documentDate: fx.org.date, amount: '25.00', post: true }, scope)
    assert.equal(posted.ok, true, JSON.stringify(posted))
    const body = (posted as { result?: { body?: { posted?: boolean } } }).result?.body
    assert.equal(body?.posted, true)
    assert.deepEqual(await journalSubsidiaries(fx.org.orgId), [fx.childId])
    const entries = await withOrgContext(fx.org.orgId, () =>
      db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id::text from journal_entries where org_id = ${fx.org.orgId}`),
    )
    assert.deepEqual(entries.rows.map((r) => r.subsidiary_id), [fx.childId])

    // Explicit root: refused as "not found"; nothing new is written.
    const refused = await callBridge(
      fx,
      appKey,
      { documentDate: fx.org.date, amount: '26.00', subsidiaryId: fx.org.subsidiaryId },
      scope,
    )
    assert.equal(refused.ok, false)
    assert.match(String((refused as { error?: string }).error ?? ''), /subsidiary not found/)
    assert.deepEqual(await journalSubsidiaries(fx.org.orgId), [fx.childId])

    // Empty scope: refused; unrestricted: root default is unchanged.
    const empty = await callBridge(fx, appKey, { documentDate: fx.org.date, amount: '27.00' }, new Set())
    assert.equal(empty.ok, false)
    assert.match(String((empty as { error?: string }).error ?? ''), /no available subsidiary/)
    const unrestricted = await callBridge(fx, appKey, { documentDate: fx.org.date, amount: '28.00' }, null)
    assert.equal(unrestricted.ok, true, JSON.stringify(unrestricted))
    assert.deepEqual(await journalSubsidiaries(fx.org.orgId), [fx.childId, fx.org.subsidiaryId])
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

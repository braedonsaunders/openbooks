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
const { deriveAppInvocationKey } = await import('@openbooks/engine/src/apps-invocations.ts')

const DB = !!env.OPENBOOKS_DB_URL

/**
 * Through-stack regression proofs for App backend invocation atomicity
 * (#57/#58): every material write an App backend performs must commit together
 * with its app_runs evidence inside one claimed invocation unit, so retries
 * after throws/timeouts cannot duplicate financial effects and a failing audit
 * write cannot strip committed effects of their provenance.
 */

const CUSTOM_TYPE_KEY = 'invproof'

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  user: Parameters<typeof runBridgeMethod>[0]['user']
}

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg()
    const { adminId } = await seedFlowActors(org.orgId)
    // Published custom record type so platform.create has something real to do.
    await db.execute(sql`
      insert into custom_record_types (org_id, key, name, plural_name, fields, status, created_by, updated_by)
      values (${org.orgId}, ${CUSTOM_TYPE_KEY}, 'Invocation Proof', 'Invocation Proofs',
              ${JSON.stringify([{ id: 'main', fields: [{ id: 'name', type: 'text', label: 'Name' }] }])}::jsonb,
              'published', ${adminId}, ${adminId})`)
    const user = {
      id: adminId,
      email: 'invocations@scratch.test',
      name: 'Invocation Caller',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: adminId,
      homeOrgId: org.orgId,
    }
    return { org, actorId: adminId, user }
  })
}

async function installProofApp(
  fx: Fixture,
  handlerSource: string,
  identity?: { key?: string; version?: string },
): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const manifest = {
    key: identity?.key ?? `invproof-${suffix}`,
    name: 'Invocation Proof App',
    version: identity?.version ?? '1.0.0',
    description: '',
    permissions: ['gl.post', 'records.read', 'records.create'],
    frontend: { entry: 'frontend/index.html' },
    endpoints: [{ name: 'financial', file: 'backend/financial.js', method: 'POST' }],
  }
  await withBypass(() =>
    installApp(fx.org.orgId, fx.actorId, {
      manifest,
      files: [
        { path: 'frontend/index.html', content: '<html><body>proof</body></html>' },
        { path: 'backend/financial.js', content: handlerSource },
      ],
    }),
  )
  return manifest.key
}

function callBridge(
  fx: Fixture,
  appKey: string,
  payload: unknown,
): ReturnType<typeof runBridgeMethod> {
  return runBridgeMethod({
    orgId: fx.org.orgId,
    user: fx.user,
    key: appKey,
    method: 'callBackend',
    payload,
    userCan: () => true,
    allowedSubsidiaryIds: null,
  })
}

/** One sandboxed backend doing journal + platform + KV writes. */
function financialHandler(opts: { post: boolean; thenThrow?: boolean; spinAfterPost?: boolean }): string {
  return `function handler(request) {
  var journalInput = {
    documentDate: request.body.documentDate,
    memo: 'invocation proof',
    lines: [
      { accountCode: '1000', amount: request.body.amount },
      { accountCode: '5000', amount: -request.body.amount }
    ]
  };
  var j = ob.journal.create(journalInput, { post: ${opts.post ? 'true' : 'false'} });
${opts.spinAfterPost ? '  while (true) {}' : ''}
  var r = ob.platform.create('${CUSTOM_TYPE_KEY}', { name: request.body.recordName || 'Invoked' });
  ob.storage.set('proof-key-' + request.body.amount, j.documentNumber);
${opts.thenThrow ? "  throw new Error('boom after posting');\n" : ''}
  return { journal: j.documentNumber, posted: j.entryId !== undefined, recordId: String(r.id) };
}
`
}

const committedCounts = async (
  orgId: string,
): Promise<{ documents: number; entries: number; records: number; storage: number }> => {
  const r = await withOrgContext(orgId, () =>
    db.execute<{ documents: string; entries: string; records: string; storage: string }>(sql`
      select
        (select count(*)::text from documents where org_id = ${orgId}) as documents,
        (select count(*)::text from journal_entries where org_id = ${orgId}) as entries,
        (select count(*)::text from custom_records where org_id = ${orgId}) as records,
        (select count(*)::text from app_storage where org_id = ${orgId}) as storage`),
  )
  const row = r.rows[0]!
  return {
    documents: Number(row.documents),
    entries: Number(row.entries),
    records: Number(row.records),
    storage: Number(row.storage),
  }
}

const appRuns = async (orgId: string) =>
  (
    await withOrgContext(orgId, () =>
      db.execute<{
        endpoint: string;
        status: string;
        errorMessage: string | null;
        logs: string[];
        units: number;
      }>(sql`
        select endpoint, status, error_message as "errorMessage", logs, units
          from app_runs where org_id = ${orgId}
         order by at`),
    )
  ).rows

test(
  'a successful multi-write backend commits journal, platform record, KV, and audit atomically',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      const appKey = await installProofApp(fx, financialHandler({ post: false }))
      const res = await callBridge(fx, appKey, {
        endpoint: 'financial',
        payload: { documentDate: fx.org.date, amount: '25.00' },
      })
      assert.equal(res.ok, true)
      const body = (res.result as { body?: { journal?: string } } | null)?.body
      assert.match(String(body?.journal ?? ''), /^JE-\d+$/)

      const counts = await committedCounts(fx.org.orgId)
      assert.deepEqual(counts, { documents: 1, entries: 0, records: 1, storage: 1 })

      const runs = await appRuns(fx.org.orgId)
      assert.deepEqual(runs.map((r) => [r.endpoint, r.status]), [['financial', 'ok']])
      assert.ok(runs[0]!.units > 0)
    } finally {
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'a backend that posts a ledger entry then throws leaves ZERO durable effects; retry cannot duplicate',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      // Same stable app identity across versions, so upgrading the bundle
      // does not change the app row — only its active version id.
      const appKey = `invproof-${randomUUID().slice(0, 8)}`
      await installProofApp(fx, financialHandler({ post: true, thenThrow: true }), {
        key: appKey,
        version: '1.0.0',
      })
      const payload = {
        endpoint: 'financial',
        payload: { documentDate: fx.org.date, amount: '25.00', recordName: 'Doomed' },
      }

      const refused = await callBridge(fx, appKey, payload)
      assert.equal(refused.ok, false)
      assert.match(String(refused.error ?? ''), /boom after posting/)
      assert.deepEqual(await committedCounts(fx.org.orgId), {
        documents: 0,
        entries: 0,
        records: 0,
        storage: 0,
      })
      const refusals = await appRuns(fx.org.orgId)
      assert.deepEqual(refusals.map((r) => [r.status]), [['error']])
      assert.match(String(refusals[0]!.errorMessage ?? ''), /boom after posting/)
      // The failed attempt's identity persists as UNCOMPLETED evidence: it
      // proves nothing durable happened and is what the retry takes over.
      const refusedClaims = await withOrgContext(fx.org.orgId, () =>
        db.execute<{ n: string; completedAt: Date | null }>(sql`
          select count(*)::text as n, min(completed_at)::timestamptz as "completedAt"
            from application_idempotency_keys where org_id = ${fx.org.orgId} and source = 'app'`),
      )
      assert.equal(Number(refusedClaims.rows[0]!.n), 1)
      assert.equal(refusedClaims.rows[0]!.completedAt, null)

      // Recovery ships a FIXED bundle on the same app: zero effects survived
      // the failed invocation, so the corrected execution posts exactly one
      // ledger entry under its own claimed identity — nothing duplicated.
      await installProofApp(fx, financialHandler({ post: true }), {
        key: appKey,
        version: '1.0.1',
      })
      const recovered = await callBridge(fx, appKey, payload)
      assert.equal(recovered.ok, true)
      assert.equal(await committedCounts(fx.org.orgId).then((c) => c.entries), 1)
      assert.equal(await committedCounts(fx.org.orgId).then((c) => c.records), 1)
      const takeover = await appRuns(fx.org.orgId)
      assert.deepEqual(takeover.map((r) => r.status), ['error', 'ok'])
      const claimsAfterRecovery = await withOrgContext(fx.org.orgId, () =>
        db.execute<{ total: string; done: string }>(sql`
          select count(*)::text as total,
                 (count(*) filter (where completed_at is not null))::text as done
            from application_idempotency_keys where org_id = ${fx.org.orgId} and source = 'app'`),
      )
      assert.deepEqual(claimsAfterRecovery.rows[0], { total: '2', done: '1' })
    } finally {
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'a backend that posts and then spins until its deadline is rolled back wholesale',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      const appKey = await installProofApp(fx, financialHandler({ post: true, spinAfterPost: true }))
      const startedAt = Date.now()
      const timedOut = await callBridge(fx, appKey, {
        endpoint: 'financial',
        payload: { documentDate: fx.org.date, amount: '25.00' },
      })
      assert.ok(Date.now() - startedAt >= 2500, 'expected the deadline to be reached')
      assert.equal(timedOut.ok, false)
      assert.deepEqual(await committedCounts(fx.org.orgId), {
        documents: 0,
        entries: 0,
        records: 0,
        storage: 0,
      })
      const runs = await appRuns(fx.org.orgId)
      assert.deepEqual(runs.map((r) => [r.status]), [['timeout']])
      // The timed-out attempt also leaves its uncompleted identity behind.
      const timeoutClaims = await withBypass(() =>
        db.execute<{ open: string }>(sql`
          select count(*)::text as open from application_idempotency_keys
           where org_id = ${fx.org.orgId} and source = 'app' and completed_at is null`),
      )
      assert.equal(Number(timeoutClaims.rows[0]!.open), 1)
    } finally {
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'an identical lost-result retry replays the stored outcome without duplicating the posting',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      const appKey = await installProofApp(fx, financialHandler({ post: true }))
      const requestPayload = { documentDate: fx.org.date, amount: '25.00' }

      const first = await callBridge(fx, appKey, { endpoint: 'financial', payload: requestPayload })
      assert.equal(first.ok, true)
      const firstJournal = String((first.result as { body?: { journal?: string } }).body?.journal)
      assert.match(firstJournal, /^JE-/)

      const second = await callBridge(fx, appKey, { endpoint: 'financial', payload: requestPayload })
      assert.equal(second.ok, true)
      assert.deepEqual(second.result, first.result)

      assert.deepEqual(await committedCounts(fx.org.orgId), {
        documents: 1,
        entries: 1,
        records: 1,
        storage: 1,
      })

      const versionRow = await withBypass(() =>
        db.execute<{ id: string }>(sql`select id from app_versions where org_id = ${fx.org.orgId}`),
      )
      const claims = await withOrgContext(fx.org.orgId, () =>
        db.execute<{ n: string }>(sql`
          select count(*)::text as n from application_idempotency_keys
           where org_id = ${fx.org.orgId} and source = 'app'
             and idempotency_key = ${deriveAppInvocationKey({
               versionId: versionRow.rows[0]!.id,
               endpoint: 'financial',
               body: requestPayload,
             })}`),
      )
      assert.equal(Number(claims.rows[0]!.n), 1)

      // The replay attempt is itself audited, distinctly marked.
      const runs = await appRuns(fx.org.orgId)
      assert.equal(runs.length, 2)
      assert.match(JSON.stringify(runs[1]!.logs), /replayed/)

      // Distinct input yields a distinct invocation — no false collision.
      const variant = await callBridge(fx, appKey, {
        endpoint: 'financial',
        payload: { ...requestPayload, amount: '40.00' },
      })
      assert.equal(variant.ok, true)
      const secondJournal = String((variant.result as { body?: { journal?: string } }).body?.journal)
      assert.notEqual(secondJournal, firstJournal)
      assert.equal(await committedCounts(fx.org.orgId).then((c) => c.entries), 2)
    } finally {
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

test(
  'forcing app_runs unavailability refuses the whole invocation instead of committing unaudited effects',
  { skip: !DB },
  async () => {
    const fx = await makeFixture()
    try {
      const appKey = await installProofApp(fx, financialHandler({ post: true }))
      const payload = {
        endpoint: 'financial',
        payload: { documentDate: fx.org.date, amount: '25.00' },
      }
      const triggerName = 'app_runs_fail_closed_bridge'
      await withBypass(async () => {
        await db.execute(sql`
          create or replace function fail_bridge_run_audit() returns trigger language plpgsql as $fn$
          begin
            raise exception 'app_runs unavailable';
          end
          $fn$`)
        await db.execute(sql`
          create trigger ${sql.raw(triggerName)}
            before insert on app_runs
            for each row when (new.org_id = ${sql.raw("'" + fx.org.orgId + "'")}::uuid)
            execute function fail_bridge_run_audit()`)
      })
      try {
        const refused = await callBridge(fx, appKey, payload)
        assert.equal(refused.ok, false)
        assert.match(String(refused.error ?? ''), /app_runs unavailable/)
        assert.deepEqual(await committedCounts(fx.org.orgId), {
          documents: 0,
          entries: 0,
          records: 0,
          storage: 0,
        })
      } finally {
        await withBypass(async () => {
          await db.execute(sql`drop trigger if exists ${sql.raw(triggerName)} on app_runs`)
        })
      }
      // Once evidence can be persisted again, the very same identity succeeds.
      const recovered = await callBridge(fx, appKey, payload)
      assert.equal(recovered.ok, true)
      assert.equal(await committedCounts(fx.org.orgId).then((c) => c.entries), 1)
    } finally {
      await dropScratchOrg(fx.org.orgId)
    }
  },
)

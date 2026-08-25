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

const { AppPlatformError, createAppPlatformAdapter } = await import('./platform.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

const OPENED_REVISION = '2026-08-24T12:34:56.123456Z'
const EXACT_REVISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

type PlatformList = {
  records: Record<string, unknown>[]
  total: number
}

function isConflict(error: unknown): boolean {
  return error instanceof AppPlatformError && error.status === 409
}

type PlatformFixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  platform: ReturnType<typeof createAppPlatformAdapter>
  inOrg: <Result>(work: () => Promise<Result>) => Promise<Result>
}

/** Scratch org + full-grant admin whose writes exercise the real writer stack. */
async function makePlatformFixture(seed?: (org: PlatformFixture['org'], actorId: string) => Promise<void>): Promise<PlatformFixture> {
  const { org, adminId: actorId } = await withBypass(async () => {
    const created = await createScratchOrg()
    const adminId = (await seedFlowActors(created.orgId)).adminId
    if (seed) await seed(created, adminId)
    return { org: created, adminId }
  })
  return {
    org,
    actorId,
    platform: createAppPlatformAdapter({
      orgId: org.orgId,
      user: {
        id: actorId,
        email: 'platform-occ@scratch.test',
        name: 'Platform OCC Controller',
        roles: [{ key: 'admin', name: 'Admin' }],
        orgId: org.orgId,
        envKind: 'production' as const,
        productionOrgId: org.orgId,
        isSuperAdmin: false,
        homeUserId: actorId,
        homeOrgId: org.orgId,
      },
      grantedPermissions: ['*'],
      userCan: () => true,
      allowedSubsidiaryIds: null,
    }),
    inOrg: <Result>(work: () => Promise<Result>) => withOrgContext(org.orgId, work),
  }
}

test(
  'platform document reads round-trip the exact PostgreSQL revision token',
  { skip: !env.OPENBOOKS_DB_URL },
  async (t) => {
    const documentId = randomUUID()
    const { org, platform, inOrg } = await makePlatformFixture(async (scratch, adminId) => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, currency, status, subtotal, tax_total, total, memo,
           custom, extra_dims, created_by, created_at, updated_at, updated_by)
        values
          (${documentId}, ${scratch.orgId}, 'vendor_bill', 'PLATFORM-OCC-1',
           ${scratch.vendorId}, ${scratch.subsidiaryId}, ${scratch.date}, 'CAD', 'draft',
           '0', '0', '0', 'opened value', '{}'::jsonb, '{}'::jsonb,
           ${adminId}, ${OPENED_REVISION}::timestamptz,
           ${OPENED_REVISION}::timestamptz, null)
      `)
    })

    try {
      await t.test('the prior noncanonical raw token is rejected without mutating the draft', async () => {
        const raw = await inOrg(() => db.execute<{ updatedAt: string; memo: string | null }>(sql`
          select updated_at as "updatedAt", memo
            from documents
           where org_id = ${org.orgId} and id = ${documentId}
        `))
        const priorToken = raw.rows[0]?.updatedAt
        assert.equal(priorToken, '2026-08-24 12:34:56.123456+00')
        await assert.rejects(
          inOrg(() => platform.update('bills', documentId, {
            expectedUpdatedAt: priorToken,
            memo: 'lossy overwrite',
          })),
          isConflict,
        )
        const retained = await inOrg(() => db.execute<{ memo: string | null }>(sql`
          select memo from documents where org_id = ${org.orgId} and id = ${documentId}
        `))
        assert.equal(retained.rows[0]?.memo, 'opened value')
      })

      await t.test('list emits an exact token accepted unchanged by update', async () => {
        const listed = await inOrg(() => platform.list('bills', {
          filters: [{ field: 'id', value: documentId }],
        })) as PlatformList
        assert.equal(listed.total, 1)
        const record = listed.records[0]
        assert.equal(record?.id, documentId)
        assert.equal(record?.updated_at, OPENED_REVISION)
        assert.match(String(record?.updated_at), EXACT_REVISION)
        assert.equal('__documentRevision' in (record ?? {}), false)

        await inOrg(() => platform.update('bills', documentId, {
          expectedUpdatedAt: record?.updated_at,
          memo: 'saved from list token',
        }))
        const saved = await inOrg(() => db.execute<{ memo: string | null }>(sql`
          select memo from documents where org_id = ${org.orgId} and id = ${documentId}
        `))
        assert.equal(saved.rows[0]?.memo, 'saved from list token')
      })

      await t.test('get refreshes the exact token and stale reuse still conflicts', async () => {
        const current = await inOrg(() => platform.get('bills', documentId)) as Record<string, unknown>
        const revision = current.updated_at
        assert.equal(typeof revision, 'string')
        assert.match(String(revision), EXACT_REVISION)
        assert.notEqual(revision, OPENED_REVISION)

        await inOrg(() => platform.update('bills', documentId, {
          expectedUpdatedAt: revision,
          memo: 'saved from get token',
        }))
        await assert.rejects(
          inOrg(() => platform.update('bills', documentId, {
            expectedUpdatedAt: revision,
            memo: 'stale overwrite',
          })),
          isConflict,
        )
        const final = await inOrg(() => platform.get('bills', documentId)) as Record<string, unknown>
        assert.equal(final.memo, 'saved from get token')
        assert.match(String(final.updated_at), EXACT_REVISION)
        assert.notEqual(final.updated_at, revision)
      })

      await t.test('non-document list and get records remain unchanged', async () => {
        const expected = await inOrg(() => db.execute<Record<string, unknown>>(sql`
          select * from parties where org_id = ${org.orgId} and id = ${org.vendorId}
        `))
        assert.equal(typeof expected.rows[0]?.updated_at, 'string')

        const fetched = await inOrg(() => platform.get('parties', org.vendorId))
        assert.deepEqual(fetched, expected.rows[0])

        const listed = await inOrg(() => platform.list('parties', {
          filters: [{ field: 'id', value: org.vendorId }],
        })) as PlatformList
        assert.equal(listed.total, 1)
        assert.deepEqual(listed.records, expected.rows)
      })
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'a rejected platform document create rolls back its hidden draft to zero rows',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, platform, inOrg } = await makePlatformFixture()
    const documentCount = async () => (await inOrg(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId}
    `))).rows[0]!.n
    const documentLineCount = async () => (await inOrg(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from document_lines where org_id = ${org.orgId}
    `))).rows[0]!.n

    try {
      // Control: a valid create persists exactly one draft with one line,
      // proving this path reaches the writer's persistence.
      await inOrg(() => platform.create('bills', {
        partyId: org.vendorId,
        documentDate: org.date,
        lines: [{ accountId: org.accounts.freight, amount: '5' }],
      }))
      assert.equal(await documentCount(), 1)
      assert.equal(await documentLineCount(), 1)

      // The line validator fires AFTER the writer has inserted the draft, so
      // without an atomic unit this rejection used to strand a hidden zero-row
      // bill. The transaction must erase it.
      await assert.rejects(
        inOrg(() => platform.create('bills', {
          partyId: org.vendorId,
          documentDate: org.date,
          lines: [{ amount: '5' }],
        })),
        (error) =>
          error instanceof AppPlatformError &&
          error.status === 422 &&
          /Line 1: an account is required/.test(error.message),
      )
      assert.equal(await documentCount(), 1)
      assert.equal(await documentLineCount(), 1)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'a rejected platform custom-record create rolls back its hidden draft to zero rows',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = 'platguard'
    const { org, platform, inOrg } = await makePlatformFixture(async (scratch, adminId) => {
      await db.execute(sql`
        insert into custom_record_types
          (org_id, key, name, plural_name, icon_key, fields, status, show_in_nav, created_by, updated_by)
        values (${scratch.orgId}, ${typeKey}, 'Platform Guard', 'Platform Guards', 'box',
                ${JSON.stringify([{
                  id: 'main',
                  title: 'Details',
                  fields: [{ id: 'req_code', label: 'Code', type: 'text', required: true }],
                }])}::jsonb, 'published', true, ${adminId}, ${adminId})
      `)
    })
    const recordCount = async () => (await inOrg(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from custom_records where org_id = ${org.orgId} and type_key = ${typeKey}
    `))).rows[0]!.n

    try {
      // Control: a bare create seeds and keeps its draft.
      await inOrg(() => platform.create(typeKey, {}))
      assert.equal(await recordCount(), 1)

      // Activating with the required field empty is rejected by the submit-stage
      // validator AFTER the draft row was inserted — the rollback must leave
      // only the control row.
      await assert.rejects(
        inOrg(() => platform.create(typeKey, { data: { req_code: '' }, status: 'active' })),
        (error) =>
          error instanceof AppPlatformError &&
          error.status === 422 &&
          /Fill every required field before activating/.test(error.message),
      )
      assert.equal(await recordCount(), 1)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

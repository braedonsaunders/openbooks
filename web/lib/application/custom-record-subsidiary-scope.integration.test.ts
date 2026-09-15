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
    return nextResolve(specifier, context)
  },
})

const { createApplicationRecord, listRecords, getRecord } = await import('./records.ts')
const { ApplicationError } = await import('./errors.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts',
)

test(
  'application custom-record list/get scope JSON subsidiary_id as text',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `v1-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId, hiddenRecordId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const typeId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'V1 Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'V1 Scope', 'V1 Scopes',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      const hiddenId = randomUUID()
      for (const [subsidiaryId, title] of [
        [created.subsidiaryId, 'visible'] as const,
        [branch, 'hidden'] as const,
      ]) {
        const recordId = title === 'hidden' ? hiddenId : randomUUID()
        await db.execute(sql`
          insert into custom_records
            (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${recordId}, ${created.orgId}, ${typeId}, ${typeKey}, ${randomUUID()},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      return { org: created, actorId: actor, hiddenRecordId: hiddenId }
    })

    const user = {
      id: actorId,
      email: 'v1-records-scope@scratch.test',
      name: 'V1 Records Scope',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    }
    const context = {
      authz: { user, permissions: new Set(['*']), allowedSubsidiaryIds: new Set([org.subsidiaryId]) },
      source: 'api' as const,
      requestId: randomUUID(),
      apiKeyId: null,
    }
    try {
      await withOrgContext(org.orgId, async () => {
        const listed = await listRecords(context, { typeKey })
        assert.equal(listed.total, 1)
        assert.equal((listed.records[0]?.data as { title: string }).title, 'visible')
        const requested = await listRecords(context, { typeKey, subsidiaryId: org.subsidiaryId })
        assert.equal(requested.total, 1)
        assert.equal((requested.records[0]?.data as { title: string }).title, 'visible')
        await assert.rejects(
          getRecord(context, { typeKey, id: hiddenRecordId }),
          (error: unknown) => error instanceof ApplicationError && error.code === 'not_found',
        )
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'application custom-record create rejects an out-of-scope nested subsidiary_id',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `v1-write-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const { org, actorId, branch, typeId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branchId = randomUUID()
      const customTypeId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branchId}, ${created.orgId}, ${created.subsidiaryId}, 'V1 Write Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'V1 Write Scope', 'V1 Write Scopes',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor, branch: branchId, typeId: customTypeId }
    })
    const user = {
      id: actorId,
      email: 'v1-records-write-scope@scratch.test',
      name: 'V1 Records Write Scope',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    }
    const context = {
      authz: { user, permissions: new Set(['*']), allowedSubsidiaryIds: new Set([org.subsidiaryId]) },
      source: 'api' as const,
      requestId: randomUUID(),
      apiKeyId: null,
    }
    try {
      await assert.rejects(
        withOrgContext(org.orgId, () => createApplicationRecord(context, {
          typeKey,
          body: {
            // The transport-level field passes its existing guard, while the
            // dynamic custom-record payload attempts to move the row outside scope.
            subsidiaryId: org.subsidiaryId,
            data: { subsidiary_id: branch, title: 'must not persist' },
          },
          idempotencyKey: `v1-write-${randomUUID()}`,
        })),
        (error: unknown) => error instanceof ApplicationError && error.code === 'not_found',
      )
      const rows = await withBypass(() => db.execute(sql`
        select count(*)::text as count from custom_records
         where org_id = ${org.orgId} and type_id = ${typeId}
      `))
      assert.equal(rows.rows[0]?.count, '0')
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Server-only shim so this DB test can import the resource under node.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export {}',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { setupResource } = (await import('./setup-resources.ts')) as typeof import('./setup-resources.ts')
const { SETUP_ENTITY_BY_KEY } = await import('../setup/registry.ts')
hooks.deregister()

const { db, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')

test(
  'setup imports roll back a row when audit fails and record actual snapshots on success',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg()
    const actorId = await createScratchUser(org.orgId, 'Setup Import Admin', 'admin')
    const entity = SETUP_ENTITY_BY_KEY.get('segment-definitions')
    assert.ok(entity)
    const resource = setupResource(entity, org.orgId)
    const rejectedKey = `import_audit_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const acceptedKey = `import_snapshot_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const triggerName = `setup_import_audit_veto_${randomUUID().replaceAll('-', '')}`
    const functionName = `${triggerName}_fn`

    try {
      // Forced audit failure must roll the row back to its savepoint.
      await db.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin
        if NEW.table_name = 'segment_definitions' then raise exception 'forced setup import audit failure'; end if;
        return NEW; end $$`))
      await db.execute(sql.raw(`create trigger ${triggerName} before insert on audit_log for each row execute function ${functionName}()`))

      const rejected = await resource.write(
        [
          {
            key: rejectedKey,
            name: 'Rejected setup',
            pluralName: 'Rejected setups',
          },
        ],
        'insert',
        { orgId: org.orgId, actorId, dryRun: false },
      )
      assert.equal(rejected.created, 0)
      assert.equal(rejected.failed, 1)
      assert.match(rejected.errors[0]?.message ?? '', /forced setup import audit failure/)
      const stranded = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from segment_definitions
       where org_id = ${org.orgId} and key = ${rejectedKey}`)
      assert.equal(stranded.rows[0]?.count, 0)

      // A failed nested row rolls back without stranding the outer unit.
      const outerRejectedKey = `import_outer_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      const outerRejected = await withOrgTransaction(org.orgId, () =>
        resource.write(
          [
            {
              key: outerRejectedKey,
              name: 'Outer rejected setup',
              pluralName: 'Outer rejected setups',
            },
          ],
          'insert',
          { orgId: org.orgId, actorId, dryRun: false },
        ),
      )
      assert.equal(outerRejected.created, 0)
      assert.equal(outerRejected.failed, 1)
      const outerStranded = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from segment_definitions
       where org_id = ${org.orgId} and key = ${outerRejectedKey}`)
      assert.equal(outerStranded.rows[0]?.count, 0)

      await db.execute(sql.raw(`drop trigger ${triggerName} on audit_log`))

      const accepted = await resource.write(
        [
          {
            key: acceptedKey,
            name: 'Imported setup',
            pluralName: 'Imported setups',
          },
        ],
        'insert',
        { orgId: org.orgId, actorId, dryRun: false },
      )
      assert.deepEqual(
        {
          created: accepted.created,
          updated: accepted.updated,
          failed: accepted.failed,
        },
        { created: 1, updated: 0, failed: 0 },
      )

      const stored = await db.execute<{
        id: string
        key: string
        name: string
        plural_name: string
      }>(sql`
      select id, key, name, plural_name from segment_definitions
       where org_id = ${org.orgId} and key = ${acceptedKey}`)
      const storedRow = stored.rows[0]
      assert.ok(storedRow)
      const auditRows = await db.execute<{
        source: string
        before: Record<string, unknown> | null
        after: Record<string, unknown>
      }>(sql`
      select changes->>'source' as source,
             changes->'before' as before, changes->'after' as after
        from audit_log
       where org_id = ${org.orgId} and table_name = 'segment_definitions'
         and row_id = ${storedRow.id} and action = 'insert'`)
      assert.equal(auditRows.rows.length, 1)
      assert.equal(auditRows.rows[0]?.source, 'import')
      assert.equal(auditRows.rows[0]?.before, null)
      assert.equal(auditRows.rows[0]?.after.key, acceptedKey)
      assert.equal(auditRows.rows[0]?.after.name, 'Imported setup')
      assert.equal(auditRows.rows[0]?.after.plural_name, 'Imported setups')

      // Upsert atomicity: audit outage leaves neither commit nor false success.
      await db.execute(sql.raw(`create trigger ${triggerName} before insert on audit_log for each row execute function ${functionName}()`))
      const rejectedUpdate = await resource.write(
        [
          {
            key: acceptedKey,
            name: 'Should roll back',
            pluralName: 'Imported setups',
          },
        ],
        'upsert',
        { orgId: org.orgId, actorId, dryRun: false },
      )
      assert.equal(rejectedUpdate.updated, 0)
      assert.equal(rejectedUpdate.failed, 1)
      const unchanged = await db.execute<{ name: string }>(sql`
      select name from segment_definitions
       where org_id = ${org.orgId} and key = ${acceptedKey}`)
      assert.equal(unchanged.rows[0]?.name, 'Imported setup')
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${triggerName} on audit_log`)).catch(() => undefined)
      await db.execute(sql.raw(`drop function if exists ${functionName}()`)).catch(() => undefined)
      await dropScratchOrgReporting(org.orgId)
    }
  },
)

test('setup imports refuse tax codes that violate domain invariants', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = await createScratchUser(org.orgId, 'Setup Import Admin', 'admin')
  const entity = SETUP_ENTITY_BY_KEY.get('tax-codes')
  assert.ok(entity)
  const code = `WHT-${randomUUID().replaceAll('-', '').slice(0, 8)}`
  try {
    const outcome = await setupResource(entity, org.orgId).write(
      [{ code, name: 'Import withholding', calculationType: 'withholding' }], 'insert', { orgId: org.orgId, actorId, dryRun: false })
    assert.deepEqual([outcome.created, outcome.failed, outcome.errors[0]?.message], [0, 1, 'withholding-account-required'])
    const stored = await db.execute(sql`select count(*)::int as count from tax_codes where org_id = ${org.orgId} and code = ${code}`)
    assert.equal(stored.rows[0]?.count, 0)
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

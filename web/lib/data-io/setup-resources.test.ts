import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Server-only shim so this DB test can import the resource under node.
const { setupResource } = (await import('./setup-resources.ts')) as typeof import('./setup-resources.ts')
const { SETUP_ENTITY_BY_KEY, SETUP_PROJECTS_OR_MANUFACTURING_REMEDY } = await import('../setup/registry.ts')
const { resolvedFeatureState } = await import('../features.ts')

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

/** Pin the org's feature flags, then read the state back so a zero-row write
 *  fails loudly here instead of silently testing the defaults. */
async function setImportFeatures(orgId: string, flags: Record<string, boolean>): Promise<void> {
  await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb, true) where id = ${orgId}`)
  const state = await resolvedFeatureState(orgId)
  for (const [key, value] of Object.entries(flags)) {
    assert.equal(state[key], value, `feature flag ${key} did not persist`)
  }
}

/** A test-local any-of descriptor. Its table does not exist, so any storage
 *  touch would throw a database error — a per-row refusal proves the gate
 *  lands before preview, columns, locks, or writes. */
function registerImportProbe(key: string, featureKeysAny: string[]): void {
  SETUP_ENTITY_BY_KEY.set(key, {
    key,
    table: 'c7a_consumer_probe_missing_table',
    groupKey: 'projects',
    iconKey: 'briefcase',
    orgScoped: true,
    hasActive: false,
    featureKeysAny,
    columns: [],
    fields: [],
  })
}

test('setup imports refuse a both-off any-of entity with the shared exact remedy', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = await createScratchUser(org.orgId, 'Setup Import Gate Admin', 'admin')
  const probeKey = 'c7a-import-any-of-probe'
  registerImportProbe(probeKey, ['projects', 'manufacturing'])
  try {
    await setImportFeatures(org.orgId, { projects: false, manufacturing: false })
    const entity = SETUP_ENTITY_BY_KEY.get(probeKey)
    assert.ok(entity)
    // Commit and preview refuse alike, naming the single exported remedy —
    // never a rewritten copy, and with no observable storage effect.
    for (const dryRun of [false, true]) {
      const outcome = await setupResource(entity, org.orgId).write(
        [{ ratePercent: '12.5', effectiveFrom: '2026-01-01' }],
        'insert',
        { orgId: org.orgId, actorId, dryRun },
      )
      assert.deepEqual([outcome.created, outcome.updated, outcome.failed], [0, 0, 1])
      assert.equal(outcome.errors[0]?.message, SETUP_PROJECTS_OR_MANUFACTURING_REMEDY)
    }
    // Either member on admits through the same gate. The missing table then
    // throws past the gate — a refusal would have returned a per-row outcome
    // instead, so any throw here is itself the admission signal.
    await setImportFeatures(org.orgId, { projects: false, manufacturing: true })
    await assert.rejects(
      setupResource(entity, org.orgId).write(
        [{ ratePercent: '12.5', effectiveFrom: '2026-01-01' }],
        'insert',
        { orgId: org.orgId, actorId, dryRun: false },
      ),
      (error: unknown) => error instanceof Error && error.message !== SETUP_PROJECTS_OR_MANUFACTURING_REMEDY,
    )
  } finally {
    SETUP_ENTITY_BY_KEY.delete(probeKey)
    await dropScratchOrgReporting(org.orgId)
  }
})

test('setup imports fail closed on unknown any-of keys', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = await createScratchUser(org.orgId, 'Setup Import Unknown Admin', 'admin')
  const probeKey = 'c7a-import-unknown-probe'
  registerImportProbe(probeKey, ['no-such-feature'])
  try {
    await setImportFeatures(org.orgId, { projects: true, manufacturing: true, inventory: true })
    const entity = SETUP_ENTITY_BY_KEY.get(probeKey)
    assert.ok(entity)
    const outcome = await setupResource(entity, org.orgId).write(
      [{ ratePercent: '12.5', effectiveFrom: '2026-01-01' }],
      'insert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.deepEqual([outcome.created, outcome.updated, outcome.failed], [0, 0, 1])
    assert.match(outcome.errors[0]?.message ?? '', /Company Settings → Features/)
  } finally {
    SETUP_ENTITY_BY_KEY.delete(probeKey)
    await dropScratchOrgReporting(org.orgId)
  }
})

test('setup imports keep single-key refusal and admit when the feature is on', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = await createScratchUser(org.orgId, 'Setup Import Single Admin', 'admin')
  const entity = SETUP_ENTITY_BY_KEY.get('overhead-rates')
  assert.ok(entity)
  try {
    await setImportFeatures(org.orgId, { projects: false })
    const refused = await setupResource(entity, org.orgId).write(
      [{ ratePercent: '12.5', effectiveFrom: '2026-01-01' }],
      'insert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.deepEqual([refused.created, refused.failed, refused.errors[0]?.message], [0, 1, 'resource is not available'])
    await setImportFeatures(org.orgId, { projects: true })
    const admitted = await setupResource(entity, org.orgId).write(
      [{ ratePercent: '12.5', effectiveFrom: '2026-01-01' }],
      'insert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.deepEqual([admitted.created, admitted.failed], [1, 0])
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

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

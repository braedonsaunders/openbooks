import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { db, pool, withBypass } from './db.ts'
import { createScratchOrg, dropScratchOrg } from './test-fixtures.ts'
import { listSchema, runUserSql } from './sqlapi.ts'

const DB = !!process.env.OPENBOOKS_DB_URL

test('governed SQL catalog enforces tenant RLS and denies credential surfaces', { skip: !DB }, async () => {
  const first = await withBypass(() => createScratchOrg())
  const second = await withBypass(() => createScratchOrg())
  try {
    const firstTaxGroupId = randomUUID()
    const firstTaxCodeId = randomUUID()
    const firstTaxMemberId = randomUUID()
    const secondTaxGroupId = randomUUID()
    const secondTaxCodeId = randomUUID()
    const secondTaxMemberId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into tax_codes (id, org_id, code, name)
        values
          (${firstTaxCodeId}, ${first.orgId}, ${`FIRST-${first.orgId.slice(0, 8)}`}, 'First tenant tax'),
          (${secondTaxCodeId}, ${second.orgId}, ${`SECOND-${second.orgId.slice(0, 8)}`}, 'Second tenant tax')
      `)
      await db.execute(sql`
        insert into tax_groups (id, org_id, code, name)
        values
          (${firstTaxGroupId}, ${first.orgId}, ${`FIRST-${first.orgId.slice(0, 8)}`}, 'First tenant group'),
          (${secondTaxGroupId}, ${second.orgId}, ${`SECOND-${second.orgId.slice(0, 8)}`}, 'Second tenant group')
      `)
      await db.execute(sql`
        insert into tax_group_members (id, tax_group_id, tax_code_id, sequence)
        values
          (${firstTaxMemberId}, ${firstTaxGroupId}, ${firstTaxCodeId}, 1),
          (${secondTaxMemberId}, ${secondTaxGroupId}, ${secondTaxCodeId}, 1)
      `)
    })

    const firstRows = await runUserSql(
      'select distinct org_id::text as org_id from accounts order by org_id',
      { orgId: first.orgId },
    )
    const secondRows = await runUserSql(
      'select distinct org_id::text as org_id from accounts order by org_id',
      { orgId: second.orgId },
    )
    assert.deepEqual(firstRows.rows, [{ org_id: first.orgId }])
    assert.deepEqual(secondRows.rows, [{ org_id: second.orgId }])
    const boundary = await runUserSql(
      `select current_setting('transaction_read_only') as read_only,
              current_user as current_user,
              current_schema as current_schema,
              current_setting('app.current_org') as current_org,
              current_setting('app.bypass_rls') as bypass_rls`,
      { orgId: first.orgId },
    )
    assert.deepEqual(boundary.rows, [{
      read_only: 'on',
      current_user: 'openbooks_read',
      current_schema: 'openbooks_query',
      current_org: first.orgId,
      bypass_rls: 'off',
    }])
    const capped = await runUserSql('select generate_series(1, 3) as value', {
      orgId: first.orgId,
      maxRows: 2,
    })
    assert.deepEqual(capped.rows, [{ value: 1 }, { value: 2 }])
    assert.equal(capped.truncated, true)
    await assert.rejects(
      runUserSql('select lo_create(0)', { orgId: first.orgId }),
      /read-only transaction/i,
    )
    await assert.rejects(
      runUserSql('select pg_sleep(0.1)', { orgId: first.orgId, timeoutMs: 20 }),
      /statement timeout|canceling statement/i,
    )
    const firstTaxMembers = await runUserSql(
      'select id::text as id from tax_group_members order by id',
      { orgId: first.orgId },
    )
    const secondTaxMembers = await runUserSql(
      'select id::text as id from tax_group_members order by id',
      { orgId: second.orgId },
    )
    assert.deepEqual(firstTaxMembers.rows, [{ id: firstTaxMemberId }])
    assert.deepEqual(secondTaxMembers.rows, [{ id: secondTaxMemberId }])

    const catalog = await listSchema(first.orgId)
    const byName = new Map(catalog.map((relation) => [relation.name, relation]))
    for (const forbidden of [
      'users',
      'user_org_access',
      'api_keys',
      'connections',
      'orgs',
      'qbd_sessions',
      'sftp_servers',
      'bank_feed_connections',
      'payment_links',
      'psp_provider_configs',
      'tax_rate_provider_configs',
    ]) {
      assert.equal(byName.has(forbidden), false, `${forbidden} must not be introspectable`)
    }
    assert.ok(byName.has('accounts'))
    assert.ok(byName.has('journal_entries'))
    assert.ok(catalog.length > 0)
    assert.equal(
      byName.get('party_bank_accounts')?.columns.some((column) => column.name === 'account_number_encrypted'),
      false,
    )
    assert.equal(
      byName.get('vendor_roles')?.columns.some((column) => column.name === 'tin_encrypted'),
      false,
    )

    await assert.rejects(
      runUserSql('select password_hash from public.users', { orgId: first.orgId }),
      /permission denied/,
    )
    await assert.rejects(
      runUserSql('select * from public.user_org_access', { orgId: first.orgId }),
      /permission denied/,
    )
    await assert.rejects(
      runUserSql('select * from public.accounts', { orgId: first.orgId }),
      /permission denied/,
    )
    try {
      const attemptedContextSwitch = await runUserSql(
        `with changed as materialized (
           select pg_catalog."set_config"('app.current_org', '${second.orgId}', true)
         )
         select distinct account.org_id::text as org_id
           from accounts account cross join changed`,
        { orgId: first.orgId },
      )
      assert.deepEqual(attemptedContextSwitch.rows, [{ org_id: first.orgId }])
    } catch (error) {
      assert.match(String(error), /permission denied for function set_config/)
    }
    const executableDefiners = await runUserSql(
      `select procedure.proname as name
         from pg_catalog.pg_proc procedure
         join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.prosecdef
          and pg_catalog.has_function_privilege(
            'openbooks_read', procedure.oid, 'execute'
          )
        order by procedure.proname`,
      { orgId: first.orgId },
    )
    assert.deepEqual(executableDefiners.rows, [{ name: 'openbooks_query_org_id' }])
    await assert.rejects(
      runUserSql('select * from pg_temp.openbooks_query_context', { orgId: first.orgId }),
      /permission denied/,
    )
    await assert.rejects(
      runUserSql('select account_number_encrypted from party_bank_accounts', { orgId: first.orgId }),
      /does not exist/,
    )
    await assert.rejects(
      runUserSql('select tin_encrypted from vendor_roles', { orgId: first.orgId }),
      /does not exist/,
    )
  } finally {
    await withBypass(() => dropScratchOrg(second.orgId))
    await withBypass(() => dropScratchOrg(first.orgId))
  }
})

test('governed SQL stays available while the ordinary request pool is saturated', { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const heldClients: PoolClient[] = []
  try {
    assert.equal(pool.options.max, 10)
    for (let index = 0; index < pool.options.max; index += 1) {
      heldClients.push(await pool.connect())
    }

    const operations = Promise.all([
      runUserSql('select 42 as answer', { orgId: org.orgId }),
      listSchema(org.orgId),
    ])
    let outcome:
      | { ok: true; value: Awaited<typeof operations> }
      | { ok: false; error: unknown }
      | undefined
    const settled = operations.then(
      (value) => { outcome = { ok: true, value }; return outcome },
      (error: unknown) => { outcome = { ok: false, error }; return outcome },
    )

    for (let turn = 0; turn < 2_000 && !outcome && pool.waitingCount === 0; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    const ordinaryWaitersWhileHeld = pool.waitingCount
    const completedWhileHeld = outcome !== undefined

    for (const client of heldClients.splice(0)) client.release()
    const finalOutcome = await settled
    if (!finalOutcome.ok) throw finalOutcome.error

    assert.equal(ordinaryWaitersWhileHeld, 0)
    assert.equal(completedWhileHeld, true)
    assert.deepEqual(finalOutcome.value[0].rows, [{ answer: 42 }])
    assert.ok(finalOutcome.value[1].length > 0)
  } finally {
    for (const client of heldClients) client.release()
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

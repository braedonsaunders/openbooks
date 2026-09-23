import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Company Settings owns the org's business time zone: it reads the
 * effective zone (UTC when unset), validates and canonicalizes writes, and
 * audits the change. Aliases a runtime accepts but supportedValuesOf omits
 * (US/Eastern) store canonical and keep working; unknown zones refuse by
 * name instead of accruing UTC days.
 */
const root = pathToFileURL(process.cwd() + '/').href
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { businessTimeZone, businessToday } = await import('@openbooks/engine/src/platform/business-date.ts')
const { readCompanySettings, updateCompanySettings } = await import('./company-settings')

async function orgSettings(orgId: string) {
  return withBypassContext(async () =>
    (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${orgId}`)).rows[0]!.settings,
  )
}

async function audits(orgId: string) {
  return withBypassContext(async () =>
    (await db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log where org_id = ${orgId} and table_name = 'orgs' and action = 'update'`)).rows,
  )
}

test('business time zone defaults to UTC and round-trips through Company Settings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    const before = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal(before.status, 200)
    assert.equal((before.body.org as Record<string, unknown>).timeZone, 'UTC')

    const saved = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'America/Toronto' }))
    assert.equal(saved.status, 200)
    assert.equal((await orgSettings(org.orgId)).timeZone, 'America/Toronto')
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).timeZone, 'America/Toronto')

    // Sibling settings keys survive the merge (no clobber).
    const settings = await orgSettings(org.orgId)
    assert.ok(settings.controlAccounts, 'control accounts survive the time-zone write')

    // The change is audited with before/after state.
    const rows = await audits(org.orgId)
    assert.ok(
      rows.some((row) => JSON.stringify(row.changes.timeZone) === '[null,"America/Toronto"]'),
      `the zone flip is audited with before/after, got ${JSON.stringify(rows.map((row) => row.changes))}`,
    )

    // Saving the effective zone again is a no-op, not a second audit row.
    const auditCount = rows.length
    const repeat = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'America/Toronto' }))
    assert.equal(repeat.status, 200)
    assert.equal((await audits(org.orgId)).length, auditCount)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an alias is canonicalized at save and days in its canonical zone', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    const saved = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'US/Eastern' }))
    assert.equal(saved.status, 200)
    assert.equal((await orgSettings(org.orgId)).timeZone, 'America/New_York')
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).timeZone, 'America/New_York')

    // A stored alias drives business dates in its zone, never UTC:
    // 2026-09-23T03:30Z is still Sep 22 on the US east coast.
    await withBypassContext(() => withSimClock('2026-09-23T03:30:00Z', async () => {
      assert.equal(await businessTimeZone(org.orgId), 'America/New_York')
      assert.equal(await businessToday(org.orgId), '2026-09-22')
    }))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an unknown zone is refused at save by name and stores nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    for (const bad of ['Mars/Olympus_Mons', 'Not/AZone', 42, {}, []]) {
      const res = await withBypassContext(() => updateCompanySettings(me, { timeZone: bad }))
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`)
      assert.match(
        String((res.body as Record<string, unknown>).error),
        /not a known IANA time zone/,
        'the refusal names the defect, not just the field',
      )
    }
    assert.equal((await orgSettings(org.orgId)).timeZone, undefined)
    assert.equal((await audits(org.orgId)).length, 0)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('clearing the zone returns the org to the UTC default and audits the removal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    assert.equal((await withBypassContext(() => updateCompanySettings(me, { timeZone: 'Pacific/Auckland' }))).status, 200)
    const cleared = await withBypassContext(() => updateCompanySettings(me, { timeZone: null }))
    assert.equal(cleared.status, 200)
    assert.equal((await orgSettings(org.orgId)).timeZone, undefined)
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).timeZone, 'UTC')
    const rows = await audits(org.orgId)
    assert.ok(
      rows.some((row) => JSON.stringify(row.changes.timeZone) === '["Pacific/Auckland",null]'),
      `the clear is audited with before/after, got ${JSON.stringify(rows.map((row) => row.changes))}`,
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

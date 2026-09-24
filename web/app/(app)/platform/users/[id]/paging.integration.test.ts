import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// User detail grants paging — platformUser must page the grant sub-list in
// SQL (limit/offset) with a stable total, because the detail page renders
// server-side from whatever the loader returns: an identity collecting
// grants across many organizations would otherwise render an unbounded
// table. Seeds more grants than one page holds and asserts page two returns
// the NEXT rows, the total equals the seeded count, and an out-of-range page
// returns an empty window with the same total (the house Pagination then
// offers the last page — the out-of-range rule).

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (specifier.startsWith('@openbooks/engine/')) {
      const root = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 1)
      return nextResolve(
        new URL(`engine/${specifier.slice('@openbooks/engine/'.length)}`, root).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { platformUser } = await import('../../../../../lib/platform-admin.ts')

const PREFIX = 'W93D'
const GRANTS = 7
const PAGE_SIZE = 5

function orgName(i: number): string {
  return `${PREFIX} Org ${String(i).padStart(2, '0')}`
}

async function seedMemberWithGrants(): Promise<{ ids: string[]; memberId: string; cleanup: () => Promise<void> }> {
  const home = await withBypass(() => createScratchOrg())
  const memberId = await withBypass(() => createScratchUser(home.orgId, `${PREFIX} Member`, 'w93d_member'))
  const targetIds: string[] = []
  for (let i = 0; i < GRANTS; i++) {
    const target = await withBypass(() => createScratchOrg())
    targetIds.push(target.orgId)
  }
  // Deterministic grant order for the assertions; the teardown guard only
  // drops orgs still named 'Scratch %', so the original names are restored
  // before the drop — a renamed org must never leak.
  const ids = [home.orgId, ...targetIds]
  const before = (await withBypass(() =>
    db.execute<{ id: string; name: string }>(sql`select id, name from orgs where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`),
  )) as { rows: { id: string; name: string }[] }
  const original = new Map(before.rows.map((row) => [row.id, row.name]))
  const actingIds: string[] = []
  for (const targetId of targetIds) {
    actingIds.push(await withBypass(() => createScratchUser(targetId, `${PREFIX} Acting`, 'w93d_acting')))
  }
  await withBypass(async () => {
    await Promise.all(
      targetIds.map((id, i) => db.execute(sql`update orgs set name = ${orgName(i)} where id = ${id}`)),
    )
    for (let i = 0; i < targetIds.length; i++) {
      const targetId = targetIds[i]!
      const acting = actingIds[i]!
      await db.execute(sql`
        insert into user_org_access (id, member_user_id, org_id, acting_user_id, is_active, created_by, updated_by)
        values (${randomUUID()}, ${memberId}, ${targetId}, ${acting}, true, ${acting}, ${acting})
      `)
    }
  })
  return {
    ids,
    memberId,
    cleanup: async () => {
      // Teardowns run sequentially: parallel drops of several orgs contend
      // on the same catalog locks and time out (LockAcquireExtended).
      for (const id of ids) {
        await withBypass(() => db.execute(sql`update orgs set name = ${original.get(id)} where id = ${id}`))
      }
      for (const id of ids) {
        await dropScratchOrg(id)
      }
    },
  }
}

test('user detail grants page in order with a stable total', async () => {
  const { memberId, cleanup } = await seedMemberWithGrants()
  try {
    const full = await platformUser(memberId)
    assert.ok(full, 'the loader returns the identity')
    assert.equal(full.totalGrants, GRANTS, 'the total equals the seeded count, not the window')
    assert.equal(full.grants.length, GRANTS, 'an unpaged read still returns every grant')
    assert.deepEqual(
      full.grants.map((grant) => grant.orgName),
      Array.from({ length: GRANTS }, (_, i) => orgName(i)),
      'the sub-list order is organization-ascending',
    )

    const first = await platformUser(memberId, { page: 1, perPage: PAGE_SIZE })
    const second = await platformUser(memberId, { page: 2, perPage: PAGE_SIZE })
    assert.equal(first?.grants.length, PAGE_SIZE, 'page one holds one page, not every grant')
    assert.equal(first?.totalGrants, GRANTS, 'the total is stable across pages')
    assert.equal(second?.totalGrants, GRANTS, 'the total is stable across pages')
    const firstIds = new Set(first?.grants.map((grant) => grant.id))
    for (const grant of second?.grants ?? []) {
      assert.ok(!firstIds.has(grant.id), `page two repeats a page-one grant (${grant.id})`)
    }
    assert.deepEqual(
      [...(first?.grants ?? []), ...(second?.grants ?? [])].map((grant) => grant.id),
      full.grants.map((grant) => grant.id),
      'pages partition the whole grant set in order',
    )

    const beyond = await platformUser(memberId, { page: 99, perPage: PAGE_SIZE })
    assert.equal(beyond?.grants.length, 0, 'an out-of-range page returns an empty window')
    assert.equal(beyond?.totalGrants, GRANTS, 'an out-of-range page keeps the total so the pager can clamp')
  } finally {
    await cleanup()
  }
})

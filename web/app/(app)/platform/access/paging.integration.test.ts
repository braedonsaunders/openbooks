import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Access list paging — platformGrants must page in SQL (limit/offset) with a
// stable total, because the list renders server-side from whatever the loader
// returns. Seeds more grants than one page holds and asserts page two returns
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
const { platformGrants } = await import('../../../../lib/platform-admin.ts')

const PREFIX = 'W93G'
const GRANTS = 7
const PAGE_SIZE = 5

function memberName(i: number): string {
  return `${PREFIX} Member ${String(i).padStart(2, '0')}`
}

function memberEmail(i: number): string {
  return `${PREFIX.toLowerCase()}-member-${String(i).padStart(2, '0')}@test.example`
}

async function seedGrants(): Promise<{ homeOrgId: string; targetOrgId: string; grantIds: string[] }> {
  const home = await withBypass(() => createScratchOrg())
  const target = await withBypass(() => createScratchOrg())
  const acting = await withBypass(() => createScratchUser(target.orgId, `${PREFIX} Acting`, 'w93g_acting'))
  const memberIds: string[] = []
  for (let i = 0; i < GRANTS; i++) {
    memberIds.push(await withBypass(() => createScratchUser(home.orgId, memberName(i), 'w93g_member')))
  }
  const grantIds: string[] = []
  await withBypass(async () => {
    for (let i = 0; i < GRANTS; i++) {
      await db.execute(sql`update users set email = ${memberEmail(i)} where id = ${memberIds[i]}`)
      const grantId = randomUUID()
      await db.execute(sql`
        insert into user_org_access (id, member_user_id, org_id, acting_user_id, is_active, created_by, updated_by)
        values (${grantId}, ${memberIds[i]}, ${target.orgId}, ${acting}, true, ${acting}, ${acting})
      `)
      grantIds.push(grantId)
    }
  })
  return { homeOrgId: home.orgId, targetOrgId: target.orgId, grantIds }
}

test('access list pages in sort order with a stable total', async () => {
  const { homeOrgId, targetOrgId } = await seedGrants()
  try {
    const full = await platformGrants({ q: PREFIX, page: 1, perPage: 50, dir: 'asc', sort: 'member' })
    assert.equal(full.total, GRANTS, 'the total equals the seeded count, not the window')
    assert.deepEqual(
      full.rows.map((row) => row.memberEmail),
      Array.from({ length: GRANTS }, (_, i) => memberEmail(i)),
      'the member sort orders by member email ascending',
    )

    const first = await platformGrants({ q: PREFIX, page: 1, perPage: PAGE_SIZE, dir: 'asc', sort: 'member' })
    const second = await platformGrants({ q: PREFIX, page: 2, perPage: PAGE_SIZE, dir: 'asc', sort: 'member' })
    assert.equal(first.rows.length, PAGE_SIZE, 'page one holds one page, not every grant')
    assert.equal(first.total, GRANTS, 'the total is stable across pages')
    assert.equal(second.total, GRANTS, 'the total is stable across pages')
    const firstIds = new Set(first.rows.map((row) => row.id))
    for (const row of second.rows) {
      assert.ok(!firstIds.has(row.id), `page two repeats a page-one grant (${row.id})`)
    }
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.id),
      full.rows.map((row) => row.id),
      'pages partition the whole filtered grant set in order',
    )

    // The pager total must be the FILTERED count: a search narrowing the
    // table to one row must report one, never the unfiltered grant size.
    const narrowed = await platformGrants({ q: memberEmail(3), page: 1, perPage: 50, dir: 'asc', sort: 'member' })
    assert.equal(narrowed.total, 1, 'a search matching one row reports a total of one')
    assert.deepEqual(
      narrowed.rows.map((row) => row.memberEmail),
      [memberEmail(3)],
      'the narrowed window holds exactly the matching row',
    )

    const beyond = await platformGrants({ q: PREFIX, page: 99, perPage: PAGE_SIZE, dir: 'asc', sort: 'member' })
    assert.equal(beyond.rows.length, 0, 'an out-of-range page returns an empty window')
    assert.equal(beyond.total, GRANTS, 'an out-of-range page keeps the total so the pager can clamp')
  } finally {
    await dropScratchOrg(homeOrgId)
    await dropScratchOrg(targetOrgId)
  }
})

test('access status filter narrows the grant set', async () => {

  const { homeOrgId, targetOrgId, grantIds } = await seedGrants()
  try {
    await withBypass(() =>
      db.execute(sql`update user_org_access set is_active = false where id = ${grantIds[0]}`),
    )
    const inactive = await platformGrants({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'desc',
      sort: 'updated',
      status: 'inactive',
    })
    assert.equal(inactive.total, 1, 'the revoked filter returns only revoked grants')
    const active = await platformGrants({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'desc',
      sort: 'updated',
      status: 'active',
    })
    assert.equal(active.total, GRANTS - 1, 'the active filter excludes revoked grants')
  } finally {
    await dropScratchOrg(homeOrgId)
    await dropScratchOrg(targetOrgId)
  }
})

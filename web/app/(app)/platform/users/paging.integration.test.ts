import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Users list paging — platformUsers must page in SQL (limit/offset) with a
// stable total, because the list renders server-side from whatever the loader
// returns. Seeds more identities than one page holds and asserts page two
// returns the NEXT rows, the total equals the seeded count, and an
// out-of-range page returns an empty window with the same total (the house
// Pagination then offers the last page — the out-of-range rule).

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
const { platformUsers } = await import('../../../../lib/platform-admin.ts')

const PREFIX = 'W93U'
const USERS = 8
const PAGE_SIZE = 5

function userName(i: number): string {
  return `${PREFIX} User ${String(i).padStart(2, '0')}`
}

async function seedUsers(): Promise<{ orgId: string; userIds: string[] }> {
  const org = await withBypass(() => createScratchOrg())
  const userIds: string[] = []
  for (let i = 0; i < USERS; i++) {
    userIds.push(await withBypass(() => createScratchUser(org.orgId, userName(i), 'w93u_member')))
  }
  return { orgId: org.orgId, userIds }
}

test('users list pages in sort order with a stable total', async () => {
  const { orgId } = await seedUsers()
  try {
    const full = await platformUsers({ q: PREFIX, page: 1, perPage: 50, dir: 'asc', sort: 'name' })
    assert.equal(full.total, USERS, 'the total equals the seeded count, not the window')
    assert.deepEqual(
      full.rows.map((row) => row.name),
      Array.from({ length: USERS }, (_, i) => userName(i)),
      'the default directory order is name-ascending',
    )

    const first = await platformUsers({ q: PREFIX, page: 1, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    const second = await platformUsers({ q: PREFIX, page: 2, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    assert.equal(first.rows.length, PAGE_SIZE, 'page one holds one page, not the directory')
    assert.equal(first.total, USERS, 'the total is stable across pages')
    assert.equal(second.total, USERS, 'the total is stable across pages')
    const firstNames = new Set(first.rows.map((row) => row.name))
    for (const row of second.rows) {
      assert.ok(!firstNames.has(row.name), `page two repeats a page-one row (${row.name})`)
    }
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.name),
      full.rows.map((row) => row.name),
      'pages partition the whole filtered directory in order',
    )

    // The pager total must be the FILTERED count: a search narrowing the
    // table to one row must report one — a table showing one row under a
    // pager claiming the whole directory is the reported defect.
    const narrowed = await platformUsers({ q: userName(3), page: 1, perPage: 50, dir: 'asc', sort: 'name' })
    assert.equal(narrowed.total, 1, 'a search matching one row reports a total of one')
    assert.deepEqual(
      narrowed.rows.map((row) => row.name),
      [userName(3)],
      'the narrowed window holds exactly the matching row',
    )

    const beyond = await platformUsers({ q: PREFIX, page: 99, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    assert.equal(beyond.rows.length, 0, 'an out-of-range page returns an empty window')
    assert.equal(beyond.total, USERS, 'an out-of-range page keeps the total so the pager can clamp')
  } finally {
    await dropScratchOrg(orgId)
  }
})

test('users status filter narrows the directory', async () => {
  const { orgId, userIds } = await seedUsers()
  try {
    await withBypass(() =>
      db.execute(sql`update users set is_active = false where id in (${sql.join(userIds.slice(0, 2).map((id) => sql`${id}`), sql`, `)})`),
    )
    const inactive = await platformUsers({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'asc',
      sort: 'name',
      status: 'inactive',
    })
    assert.equal(inactive.total, 2, 'the inactive filter returns only inactive identities')
    const active = await platformUsers({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'asc',
      sort: 'name',
      status: 'active',
    })
    assert.equal(active.total, USERS - 2, 'the active filter excludes inactive identities')
  } finally {
    await dropScratchOrg(orgId)
  }
})

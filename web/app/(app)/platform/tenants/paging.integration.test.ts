import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Tenants list paging — platformOrganizations must page in SQL (limit/offset)
// with a stable total, because the list renders server-side from whatever the
// loader returns: a loader that ignored the page would present a partial
// fleet as the whole. Seeds more organizations than one page holds and
// asserts page two returns the NEXT rows, the total equals the seeded count,
// and an out-of-range page returns an empty window with the same total (the
// house Pagination then offers the last page — the out-of-range rule).

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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { platformOrganizations } = await import('../../../../lib/platform-admin.ts')

const PREFIX = 'W93T'
const ORGS = 7
const PAGE_SIZE = 5

function orgName(i: number): string {
  return `${PREFIX} Org ${String(i).padStart(2, '0')}`
}

async function seedTenants(): Promise<{ ids: string[]; cleanup: () => Promise<void> }> {
  const ids: string[] = []
  for (let i = 0; i < ORGS; i++) {
    const org = await withBypass(() => createScratchOrg())
    ids.push(org.orgId)
  }
  // Deterministic fleet order for the assertions. The teardown guard only
  // drops orgs still named 'Scratch %', so the original names are restored
  // before the drop — a renamed org must never leak.
  const before = (await withBypass(() =>
    db.execute<{ id: string; name: string }>(sql`select id, name from orgs where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`),
  )) as { rows: { id: string; name: string }[] }
  const original = new Map(before.rows.map((row) => [row.id, row.name]))
  await withBypass(() =>
    Promise.all(
      ids.map((id, i) => db.execute(sql`update orgs set name = ${orgName(i)} where id = ${id}`)),
    ),
  )
  return {
    ids,
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

test('tenants list pages in sort order with a stable total', async () => {
  const { cleanup } = await seedTenants()
  try {
    const full = await platformOrganizations({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'asc',
      sort: 'name',
    })
    assert.equal(full.total, ORGS, 'the total equals the seeded count, not the window')
    assert.deepEqual(
      full.rows.map((row) => row.name),
      Array.from({ length: ORGS }, (_, i) => orgName(i)),
      'the default fleet order is name-ascending',
    )

    const first = await platformOrganizations({ q: PREFIX, page: 1, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    const second = await platformOrganizations({ q: PREFIX, page: 2, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    assert.equal(first.rows.length, PAGE_SIZE, 'page one holds one page, not the fleet')
    assert.equal(first.total, ORGS, 'the total is stable across pages')
    assert.equal(second.total, ORGS, 'the total is stable across pages')
    const firstNames = new Set(first.rows.map((row) => row.name))
    assert.equal(firstNames.size, PAGE_SIZE, 'page-one rows are distinct')
    for (const row of second.rows) {
      assert.ok(!firstNames.has(row.name), `page two repeats a page-one row (${row.name})`)
    }
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.name),
      full.rows.map((row) => row.name),
      'pages partition the whole filtered fleet in order',
    )

    // The pager total must be the FILTERED count: a search narrowing the
    // table to one row must report one, never the unfiltered fleet size.
    const narrowed = await platformOrganizations({ q: orgName(3), page: 1, perPage: 50, dir: 'asc', sort: 'name' })
    assert.equal(narrowed.total, 1, 'a search matching one row reports a total of one')
    assert.deepEqual(
      narrowed.rows.map((row) => row.name),
      [orgName(3)],
      'the narrowed window holds exactly the matching row',
    )

    const beyond = await platformOrganizations({ q: PREFIX, page: 99, perPage: PAGE_SIZE, dir: 'asc', sort: 'name' })
    assert.equal(beyond.rows.length, 0, 'an out-of-range page returns an empty window')
    assert.equal(beyond.total, ORGS, 'an out-of-range page keeps the total so the pager can clamp')
  } finally {
    await cleanup()
  }
})

test('tenants environment filter narrows the fleet', async () => {
  const { ids, cleanup } = await seedTenants()
  try {
    await withBypass(() =>
      db.execute(sql`update orgs set env_kind = 'sandbox' where id in (${sql.join(ids.slice(0, 2).map((id) => sql`${id}`), sql`, `)})`),
    )
    const sandboxes = await platformOrganizations({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'asc',
      sort: 'name',
      environment: 'sandbox',
    })
    assert.equal(sandboxes.total, 2, 'the sandbox filter returns only sandboxes')
    const production = await platformOrganizations({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'asc',
      sort: 'name',
      environment: 'production',
    })
    assert.equal(production.total, ORGS - 2, 'the production filter excludes sandboxes')
  } finally {
    await cleanup()
  }
})

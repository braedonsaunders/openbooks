import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Email log paging — platformEmails must page in SQL (limit/offset) with a
// stable total, because the list renders server-side from whatever the loader
// returns. Seeds more deliveries than one page holds and asserts page two
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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { platformEmails } = await import('../../../../lib/platform-admin.ts')

const PREFIX = 'W93E'
const DELIVERIES = 7
const PAGE_SIZE = 5

function subject(i: number): string {
  return `${PREFIX} Subject ${String(i).padStart(2, '0')}`
}

function recipient(i: number): string {
  return `${PREFIX.toLowerCase()}-${String(i).padStart(2, '0')}@test.example`
}

async function seedDeliveries(): Promise<string> {
  const org = await withBypass(() => createScratchOrg())
  await withBypass(async () => {
    for (let i = 0; i < DELIVERIES; i++) {
      const failed = i % 2 === 1
      await db.execute(sql`
        insert into email_log (id, org_id, subject, status, recipient_primary, recipients, provider, category_key, error_message, created_at)
        values (${randomUUID()}, ${org.orgId}, ${subject(i)}, ${failed ? 'failed' : 'sent'}, ${recipient(i)},
                ${JSON.stringify([recipient(i)])}::jsonb, 'w93e-provider', 'w93e',
                ${failed ? `w93e failure ${i}` : null}, now() - (${i} || ' minutes')::interval)
      `)
    }
  })
  return org.orgId
}

test('email log pages in sort order with a stable total', async () => {
  const orgId = await seedDeliveries()
  try {
    const full = await platformEmails({ q: PREFIX, page: 1, perPage: 50, dir: 'asc', sort: 'subject' })
    assert.equal(full.total, DELIVERIES, 'the total equals the seeded count, not the window')
    assert.deepEqual(
      full.rows.map((row) => row.subject),
      Array.from({ length: DELIVERIES }, (_, i) => subject(i)),
      'the subject sort orders ascending',
    )

    const first = await platformEmails({ q: PREFIX, page: 1, perPage: PAGE_SIZE, dir: 'asc', sort: 'subject' })
    const second = await platformEmails({ q: PREFIX, page: 2, perPage: PAGE_SIZE, dir: 'asc', sort: 'subject' })
    assert.equal(first.rows.length, PAGE_SIZE, 'page one holds one page, not every delivery')
    assert.equal(first.total, DELIVERIES, 'the total is stable across pages')
    assert.equal(second.total, DELIVERIES, 'the total is stable across pages')
    const firstIds = new Set(first.rows.map((row) => row.id))
    for (const row of second.rows) {
      assert.ok(!firstIds.has(row.id), `page two repeats a page-one delivery (${row.id})`)
    }
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.id),
      full.rows.map((row) => row.id),
      'pages partition the whole filtered log in order',
    )

    // The pager total must be the FILTERED count: a search narrowing the
    // table to one row must report one, never the unfiltered log size.
    const narrowed = await platformEmails({ q: subject(3), page: 1, perPage: 50, dir: 'asc', sort: 'subject' })
    assert.equal(narrowed.total, 1, 'a search matching one row reports a total of one')
    assert.deepEqual(
      narrowed.rows.map((row) => row.subject),
      [subject(3)],
      'the narrowed window holds exactly the matching row',
    )

    const beyond = await platformEmails({ q: PREFIX, page: 99, perPage: PAGE_SIZE, dir: 'asc', sort: 'subject' })
    assert.equal(beyond.rows.length, 0, 'an out-of-range page returns an empty window')
    assert.equal(beyond.total, DELIVERIES, 'an out-of-range page keeps the total so the pager can clamp')
  } finally {
    await dropScratchOrg(orgId)
  }
})

test('email log status filter narrows the log', async () => {
  const orgId = await seedDeliveries()
  try {
    const failed = await platformEmails({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'desc',
      sort: 'created',
      status: 'failed',
    })
    assert.equal(failed.total, 3, 'the failed filter returns only failed deliveries')
    for (const row of failed.rows) {
      assert.equal(row.status, 'failed', 'every row carries the requested status')
      assert.ok(row.errorMessage, 'failed rows keep their delivery evidence')
    }
    const sent = await platformEmails({
      q: PREFIX,
      page: 1,
      perPage: 50,
      dir: 'desc',
      sort: 'created',
      status: 'sent',
    })
    assert.equal(sent.total, DELIVERIES - 3, 'the sent filter excludes failed deliveries')
  } finally {
    await dropScratchOrg(orgId)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Only server-only is stubbed: the predicate under test must load for real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { PgDialect } = await import('drizzle-orm/pg-core')
const { subsidiaryVisibleFilter } = await import('../../../../../lib/subsidiaries')

// F-t08-015: the remittance vendor picker offered only None despite active
// vendors. Its query mapped org-wide vendors (NULL subsidiary) onto the org
// root, hiding them from subsidiary-scoped operators — while every other
// vendor surface treats a NULL subsidiary as org-wide visible
// (subsidiaryVisibleFilter with orgWideNull, matching guardSubsidiaryScope).
// The picker must use the same convention. Proved here against the shared
// predicate itself: the vendor picker's query embeds this fragment.
const dialect = new PgDialect()
const textOf = (fragment: Parameters<typeof dialect.sqlToQuery>[0]): string =>
  dialect.sqlToQuery(fragment).sql

test('the org-wide convention keeps NULL-subsidiary rows visible', () => {
  const fragment = textOf(
    subsidiaryVisibleFilter(sql`p.subsidiary_id`, new Set(['sub-1']), { orgWideNull: true }),
  )
  assert.match(fragment, /p\.subsidiary_id is null/, 'org-wide (NULL) rows stay visible')
  assert.match(fragment, /= any\(/, 'scoped ids still narrow the visible set')
  assert.ok(!/coalesce/i.test(fragment), 'NULL rows are never remapped onto another subsidiary')
})

test('an empty scope denies documents instead of opening them', () => {
  const fragment = textOf(subsidiaryVisibleFilter(sql`p.subsidiary_id`, new Set()))
  assert.match(fragment, /and false/, 'no visible subsidiary means no visible rows')
})

test('an unrestricted caller gets no fragment at all', () => {
  const fragment = textOf(subsidiaryVisibleFilter(sql`p.subsidiary_id`, null))
  assert.equal(fragment.trim(), '', 'unrestricted callers filter nothing')
})

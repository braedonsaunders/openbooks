import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The book-selection contract behind every book-resolving report view and the
// statement exports: only an omitted selection defaults to the primary book.
// A stale or foreign explicit selection must never silently change the
// accounting basis. Postgres is live; only the server-only marker is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { reportBookSelection, ReportBookSelectionError } = await import('../../../lib/report-books.ts')
const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')


test('a one-book org resolves its primary book with no selection', async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    // The fixture seeds exactly one active book, the primary 'PRI'.
    const selection = await withOrgContext(org.orgId, () => reportBookSelection(org.orgId, null))
    assert.equal(selection.books.length, 1, 'a fresh org holds one accounting book')
    assert.equal(selection.selectedBook.code, 'PRI', 'an omitted selection defaults to the primary book')
    assert.equal(selection.selectedBook.is_primary, true)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('a second book joins the catalog and the default stays primary', async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const secondId = randomUUID()
    await withBypass(() => db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondId}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)`))
    const selection = await withOrgContext(org.orgId, () => reportBookSelection(org.orgId, undefined))
    assert.equal(selection.books.length, 2, 'both books are visible to the picker')
    assert.equal(selection.selectedBook.code, 'PRI', 'adding a book must not move the default off primary')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('an explicit book id resolves case-insensitively', async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const secondId = randomUUID()
    await withBypass(() => db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondId}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)`))
    const selection = await withOrgContext(org.orgId, () => reportBookSelection(org.orgId, secondId.toUpperCase()))
    assert.equal(selection.selectedBook.id, secondId, 'an upper-cased id from a URL still resolves')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('an unknown book id is refused instead of defaulted', async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    // A stale bookmark or a foreign org's id must never silently rebase the
    // report onto the primary book.
    await assert.rejects(
      withOrgContext(org.orgId, () => reportBookSelection(org.orgId, randomUUID())),
      (error: unknown) => {
        assert.ok(error instanceof ReportBookSelectionError, 'the refusal must be typed')
        return true
      },
    )
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t08-015: the remittance vendor picker offered only None despite active
// vendors. Its query mapped org-wide vendors (NULL subsidiary) onto the org
// root, hiding them from subsidiary-scoped operators — while every other
// vendor surface treats a NULL subsidiary as org-wide visible
// (subsidiaryVisibleFilter with orgWideNull, matching guardSubsidiaryScope).
// The picker must use the same convention.
const source = readFileSync(new URL('./sections.tsx', import.meta.url), 'utf8')

test('the vendor picker treats org-wide vendors as visible', () => {
  assert.match(source, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, [^)]*\{ orgWideNull: true \}\)/)
})

test('the vendor picker no longer maps vendors onto the root subsidiary', () => {
  assert.doesNotMatch(source, /coalesce\(p\.subsidiary_id/)
})

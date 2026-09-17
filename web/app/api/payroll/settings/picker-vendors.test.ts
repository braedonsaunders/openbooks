import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t08-015 residual: the setup wizard's FIT Remittance vendor listbox still
// offered only None with 8 active vendors. The Accounts-tab picker was fixed
// (sections.tsx), but the wizard reads GET /api/payroll/settings, whose
// pickerOptions carried the same NULL-subsidiary-maps-onto-root bug —
// hiding every org-wide vendor from subsidiary-scoped operators. Both
// pickers must treat a NULL subsidiary as org-wide visible
// (subsidiaryVisibleFilter with orgWideNull, matching guardSubsidiaryScope).
const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

test('the settings vendor picker treats org-wide vendors as visible', () => {
  assert.match(source, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, [^)]*\{ orgWideNull: true \}\)/)
})

test('the settings vendor picker no longer maps vendors onto the root subsidiary', () => {
  assert.doesNotMatch(source, /coalesce\(p\.subsidiary_id/)
})

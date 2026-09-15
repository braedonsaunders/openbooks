import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('subcontract workspace pickers enforce subsidiary visibility', () => {
  assert.match(view, /subsidiaryVisibleFilter\(sql`subsidiary_id`, authz\.allowedSubsidiaryIds\)/)
  const scopedFilters = view.match(/subsidiaryVisibleFilter\(sql`(?:p\.)?subsidiary_id`, authz\.allowedSubsidiaryIds/g) ?? []
  assert.equal(scopedFilters.length, 4, 'project, both vendor branches, and joint-party picker must be scoped')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8')
}

const routes = [
  'app/api/timesheets/route.ts',
  'app/api/timesheets/approve/route.ts',
  'app/api/timesheets/reopen/route.ts',
  'app/api/timesheets/submit/route.ts',
  'app/api/timesheets/reject/route.ts',
]

test('timesheet employee pinning fails closed for empty and restricted scopes', () => {
  const lib = source('app/api/timesheets/_lib.ts')
  assert.match(lib, /select id, subsidiary_id from parties/)
  assert.match(lib, /subsidiaryScopeAllows\(allowedSubsidiaryIds, row\.subsidiary_id\)/)
  assert.match(lib, /if \(!row\) return null/)
  assert.match(lib, /return null/)
  // The shared gate itself treats null as unrestricted and an empty Set as
  // deny-all; this boundary must call it instead of inventing a fallback.
  const authz = source('lib/authz.ts')
  assert.match(authz, /if \(scope === null\) return true/)
  assert.match(authz, /return scope\.has\(subsidiaryId\)/)
})

for (const route of routes) {
  test(`${route} carries the caller subsidiary scope into employee pinning`, () => {
    const src = source(route)
    assert.match(src, /pinTimesheetEmployee\([\s\S]*?gate\.allowedSubsidiaryIds/)
  })
}

test('timesheet saves scope their project and department references', () => {
  const src = source('app/api/timesheets/route.ts')
  assert.match(src, /pinTimesheetLineRefs\([\s\S]*?gate\.allowedSubsidiaryIds/)
  const lib = source('app/api/timesheets/_lib.ts')
  assert.match(lib, /select id, subsidiary_id from projects/)
  assert.match(lib, /select id, subsidiary_id from departments/)
  assert.match(lib, /subsidiaryScopeAllows\(allowedSubsidiaryIds, row\.subsidiary_id/)
})

test('amendment by entry id is scope-pinned before the mutation service reads it', () => {
  const src = source('app/api/timesheets/amend/route.ts')
  const pin = src.indexOf('pinTimesheetEntryEmployee(')
  const mutate = src.indexOf('amendTimeEntry(')
  assert.ok(pin >= 0 && pin < mutate, 'source entry scope must precede amendment reads/writes')
  assert.match(src, /pinTimesheetEntryEmployee\([\s\S]*?gate\.allowedSubsidiaryIds/)
})

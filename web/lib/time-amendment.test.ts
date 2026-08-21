import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('a weekly save never deletes amendment offsets', () => {
  const route = source('app/api/timesheets/route.ts')
  assert.match(route, /and amends_entry_id is null/)
  assert.match(route, /overhead_journal_entry_id is null/)
})

test('the week grid keeps amendments on their own immutable line', () => {
  const lib = source('app/api/timesheets/_lib.ts')
  assert.match(lib, /r\.amends_entry_id \?\? ''/)
  assert.match(lib, /amendsEntryId: r\.amends_entry_id/)
  assert.match(lib, /immutable: r\.status === 'approved'/)
})

test('amending a locked week returns the header to draft', () => {
  const service = source('lib/time-amendment.ts')
  assert.match(service, /export async function amendLockedWeek/)
  assert.match(service, /setTimesheetWeekStatus\([\s\S]*'draft'/)
  assert.match(service, /neg\(row\.hours\)/)
})

test('the weekly editor offers Amend when reopen is refused', () => {
  const grid = source('app/(app)/timesheets/WeeklyGrid.tsx')
  assert.match(grid, /\/api\/timesheets\/amend/)
  assert.match(grid, /canDoAmend/)
  assert.match(grid, /rows\.filter\(\(r\) => !r\.immutable\)/)
})

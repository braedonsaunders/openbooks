import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('a weekly save never deletes amendment offsets', () => {
  const route = source('app/api/timesheets/route.ts')
  // The save reconciles instead of wiping: offsets and contra-referenced
  // rows are excluded from the replaceable set, and the delete touches
  // only the collected replaceable ids. Behaviour is proven by the
  // 'never deletes amendment offsets or their referenced originals'
  // integration test in save-controls.
  assert.match(route, /row\.amends_entry_id != null \|\| row\.has_contra\) return false/, 'offsets are not replaceable')
  assert.match(route, /id = any\(/, 'the delete is limited to replaceable ids')
  assert.match(route, /row\.overhead_journal_entry_id == null/, 'consumed entries stay out of the replaceable set')
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

test('a single-entry amendment amends approved history only', () => {
  const service = source('lib/time-amendment.ts')
  assert.match(service, /row\.status !== 'approved'/)
  assert.match(service, /only an approved entry can be amended/)
})

test('reopening refuses amendment history in both link directions', () => {
  const route = source('app/api/timesheets/reopen/route.ts')
  assert.match(route, /entry\.amends_entry_id is not null/, 'offsets pointing at an original refuse the reopen')
  assert.match(route, /contra\.amends_entry_id = entry\.id/, 'originals pointed at by an offset refuse the reopen')
})

test('a weekly save never deletes an amendment-referenced original', () => {
  const route = source('app/api/timesheets/route.ts')
  // Behaviour is proven by the 'never deletes amendment offsets or their
  // referenced originals' integration test in save-controls; this pins the
  // mechanism: the locked read detects referencing offsets and the
  // replaceable set excludes them before the delete runs.
  assert.match(route, /contra\.amends_entry_id = time_entries\.id/, 'the locked read detects referencing offsets')
  const guard = route.indexOf('row.has_contra) return false')
  const del = route.indexOf('delete from time_entries')
  assert.ok(guard >= 0 && guard < del, 'referenced originals leave the replaceable set before the delete')
})

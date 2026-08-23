import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const route = readFileSync(join(webRoot, 'app/api/recurring/[id]/route.ts'), 'utf8')
const deleteHandler = route.slice(
  route.indexOf('export async function DELETE'),
  route.indexOf('/** Run now', route.indexOf('export async function DELETE')),
)

test('missing recurring schedule returns 404 without a delete audit', () => {
  const snapshot = deleteHandler.indexOf('select * from recurring_schedules')
  const missingGuard = deleteHandler.indexOf('if (!existing.rows[0]) return true')
  const deletion = deleteHandler.indexOf('delete from recurring_schedules')
  const audit = deleteHandler.indexOf('insert into audit_log')

  assert.ok(snapshot >= 0, 'the route snapshots the organization-owned schedule')
  assert.ok(missingGuard > snapshot, 'the route checks whether the snapshot exists')
  assert.ok(deletion > missingGuard, 'a missing schedule returns before deletion')
  assert.ok(audit > missingGuard, 'a missing schedule returns before audit insertion')
  assert.match(
    deleteHandler,
    /if \(missing\) return NextResponse\.json\(\{ error: "not found" \}, \{ status: 404 \}\)/,
  )
})

test('existing recurring schedule is locked, deleted, and audited with its true before-state', () => {
  assert.match(deleteHandler, /db\.transaction\(async \(tx\)/)
  assert.match(
    deleteHandler,
    /select \* from recurring_schedules where id = \$\{id\} and org_id = \$\{authz\.user\.orgId\}[\s\S]*for update/,
  )
  assert.match(
    deleteHandler,
    /delete from recurring_schedules where id = \$\{id\} and org_id = \$\{authz\.user\.orgId\}/,
  )
  assert.match(deleteHandler, /insert into audit_log/)
  assert.match(deleteHandler, /JSON\.stringify\(\{ before: existing\.rows\[0\], after: null \}\)/)
  assert.doesNotMatch(deleteHandler, /before: existing\.rows\[0\] \?\? null/)
})

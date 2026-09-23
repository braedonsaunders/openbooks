import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('custom report editor exposes a confirmed custom-only delete action', () => {
  const builder = source('app/(app)/reports/custom/builder/[id]/ReportBuilder.tsx')

  assert.match(builder, /definition\.kind === 'custom'/)
  assert.match(builder, /confirmDialog\(\{[\s\S]*tone: 'danger'/)
  assert.match(builder, /method: 'DELETE'/)
  assert.match(builder, /router\.push\('\/reports\/custom'\)/)
  assert.match(builder, /variant="destructive"/)
})

test('custom report deletion is tenant-scoped, atomic, and audited', () => {
  const route = source('app/api/reports/definitions/[id]/route.ts')

  assert.match(route, /guardPermission\('reports\.create'\)/)
  assert.match(route, /Built-in reports cannot be deleted/)
  assert.match(route, /db\.transaction/)
  assert.match(route, /where id = \$\{id\} and org_id = \$\{user\.orgId\} and kind = 'custom'/)

  // The audit evidence is written by the shared setup-audit writer, not by
  // inline SQL: the literal `insert into audit_log` lives in
  // lib/setup/audit.ts. Assert the property that matters — the archive
  // mutation and its audit share ONE transaction executor, so a failing
  // audit rolls the archive back instead of landing an unevidenced delete.
  const del = route.slice(route.indexOf('export async function DELETE'))
  assert.match(del, /auditSetupChange\(/)
  // (tx.execute carries a RowType generic, so match the executor and the
  // statement it runs rather than the literal call punctuation.)
  assert.match(del, /tx\.execute[\s\S]{0,120}?update report_definitions set/)
  assert.match(del, /auditSetupChange\([\s\S]*?,\s*tx[,]?\s*\)/)
  assert.ok(
    del.indexOf('db.transaction') < del.indexOf('update report_definitions')
      && del.indexOf('update report_definitions') < del.indexOf('auditSetupChange('),
    'the archive mutation and its audit must both run inside the same transaction',
  )
  assert.match(del, /before: existing, after/)
  // Schedules stop in the same transaction (no orphaned future runs) and
  // history is preserved by archive stamp, never a hard delete.
  assert.match(del, /update report_schedules set active = false/)
  assert.match(del, /archived_at = clock_timestamp\(\)/)
})

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
  assert.match(route, /insert into audit_log/)
  assert.match(route, /before: snapshot/)
  assert.match(route, /after: null/)
  assert.match(route, /schedule_count/)
  assert.match(route, /run_count/)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const route = readFileSync(join(webRoot, 'app/api/recurring/[id]/route.ts'), 'utf8')
const collectionsClient = readFileSync(join(webRoot, 'app/(app)/collections/CollectionsClient.tsx'), 'utf8')
const arMessages = JSON.parse(readFileSync(join(webRoot, 'messages/en/ar.json'), 'utf8')) as {
  collections: { recurring: Record<string, string> }
}
const deleteHandler = route.slice(
  route.indexOf('export async function DELETE'),
  route.indexOf('/** Run now', route.indexOf('export async function DELETE')),
)
const recurringAct = collectionsClient.slice(
  collectionsClient.indexOf('const act = async'),
  collectionsClient.indexOf('\n\n  return (', collectionsClient.indexOf('const act = async')),
)

test('missing recurring schedule returns 404 without a delete audit', () => {
  const snapshot = deleteHandler.indexOf('await ownedEnabled(tx, authz, id)')
  const missingGuard = deleteHandler.indexOf('if (!existing) return "not_found"')
  const deletion = deleteHandler.indexOf('delete from recurring_schedules')
  const audit = deleteHandler.indexOf('insert into audit_log')

  assert.ok(snapshot >= 0, 'the route snapshots the organization-owned schedule')
  assert.ok(missingGuard > snapshot, 'the route checks whether the snapshot exists')
  assert.ok(deletion > missingGuard, 'a missing schedule returns before deletion')
  assert.ok(audit > missingGuard, 'a missing schedule returns before audit insertion')
  assert.match(
    deleteHandler,
    /if \(outcome === "not_found"\) return NextResponse\.json\(\{ error: "not found" \}, \{ status: 404 \}\)/,
  )
})

test('recurring schedule with generated documents returns a localized-safe 409 before deletion', () => {
  const lineageLookup = deleteHandler.indexOf('from recurring_occurrence_documents')
  const lineageGuard = deleteHandler.indexOf('if (lineage.rows[0]) return "generated_documents_exist"')
  const deletion = deleteHandler.indexOf('delete from recurring_schedules')

  assert.ok(lineageLookup >= 0, 'the route checks immutable generated-document lineage')
  assert.ok(lineageGuard > lineageLookup, 'the route refuses a schedule linked to generated documents')
  assert.ok(deletion > lineageGuard, 'the lineage refusal happens before deletion is attempted')
  assert.match(
    deleteHandler,
    /where schedule_id = \$\{id\} and org_id = \$\{authz\.user\.orgId\}/,
  )
  assert.match(deleteHandler, /outcome === "generated_documents_exist"/)
  assert.match(deleteHandler, /code: "generated_documents_exist"/)
  assert.match(deleteHandler, /immutable lineage must be preserved/)
  assert.match(deleteHandler, /\{ status: 409 \}/)
})

test('existing recurring schedule is locked, deleted, and audited with its true before-state', () => {
  assert.match(deleteHandler, /db\.transaction\(async \(tx\)/)
  assert.match(
    route,
    /where rs\.id = \$\{id\} and rs\.org_id = \$\{authz\.user\.orgId\}[\s\S]*for update of rs for share of d/,
  )
  assert.match(
    deleteHandler,
    /delete from recurring_schedules where id = \$\{id\} and org_id = \$\{authz\.user\.orgId\}/,
  )
  assert.match(deleteHandler, /insert into audit_log/)
  assert.match(deleteHandler, /JSON\.stringify\(\{ before: existing, after: null \}\)/)
  assert.doesNotMatch(deleteHandler, /before: existing\.rows\[0\] \?\? null/)
  assert.match(deleteHandler, /return "deleted" as const/)
  assert.match(deleteHandler, /return NextResponse\.json\(\{ ok: true \}\)/)
})

test('recurring schedule action failures display the generated-document conflict message', () => {
  assert.match(recurringAct, /const result = await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
  assert.match(recurringAct, /if \(!r\.ok\)/)
  assert.match(recurringAct, /result\.code === "generated_documents_exist"/)
  assert.match(recurringAct, /t\("generatedDocumentsDeleteConflict"\)/)
  assert.equal(
    arMessages.collections.recurring.generatedDocumentsDeleteConflict,
    'This recurring schedule cannot be deleted because it has generated documents. Their source history must be preserved.',
  )
})

test('run now passes the authenticated user to recurring generation', () => {
  assert.match(route, /runScheduleNow\(id,\s*authz\.user\.id, undefined,/)
})

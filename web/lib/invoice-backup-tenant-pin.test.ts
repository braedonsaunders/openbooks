import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./invoice-backup.ts', import.meta.url), 'utf8')

test('invoice backup upserts pin the known tenant on the org_id/document_id conflict write', () => {
  assert.match(
    source,
    /insert into invoice_backups[\s\S]*?on conflict \(org_id, document_id\) do update[\s\S]*?where invoice_backups\.org_id = \$\{orgId\}/,
  )
})

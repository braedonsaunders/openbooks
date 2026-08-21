import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ATTACHABLE_TARGET_TABLES, isAttachableTargetTable } from './target-tables.ts'

test('allowlist covers exactly the tables the app attaches files to', () => {
  assert.deepEqual(
    [...ATTACHABLE_TARGET_TABLES].sort(),
    ['compliance_records', 'documents', 'fixed_assets', 'item_rate_versions', 'lien_waivers', 'parties'],
  )
})

test('every real attachment target is accepted', () => {
  for (const t of ['documents', 'parties', 'item_rate_versions', 'fixed_assets', 'compliance_records', 'lien_waivers']) {
    assert.equal(isAttachableTargetTable(t), true, t)
  }
})

test('arbitrary or lookalike target tables are refused', () => {
  for (const t of ['', 'users', 'orgs', 'journal_entries', 'audit_log', 'pg_catalog.pg_tables', 'documents;', 'documents ', 'Documents', 'file_attachments']) {
    assert.equal(isAttachableTargetTable(t), false, t)
  }
})

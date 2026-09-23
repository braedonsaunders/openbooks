import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PERMISSION_GROUPS } from '../../engine/src/organization/permissions.ts'

// The role editor renders every permission through its catalogue labelKey
// (admin.<labelKey>). A permission added to the catalogue without a message
// fell back to its raw key with MISSING_MESSAGE in the console
// (hrm.documents.read/manage and hrm.surveys.manage shipped that way).
// Derived from PERMISSION_GROUPS, never hand-listed: every group and
// permission label exists, non-empty, in every locale's admin catalogue.
const messagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages')

function lookup(catalog: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    catalog,
  )
}

test('every permission group and permission has an admin label in every locale', () => {
  const labelKeys = PERMISSION_GROUPS.flatMap((group) => [
    group.labelKey,
    ...group.permissions.map((permission) => permission.labelKey),
  ])
  assert.ok(labelKeys.length > 100, `expected the permission catalogue, found ${labelKeys.length} labels`)
  const locales = readdirSync(messagesRoot).filter((name) => statSync(join(messagesRoot, name)).isDirectory())
  assert.ok(locales.includes('en'))
  const missing: string[] = []
  for (const locale of locales) {
    const admin = JSON.parse(readFileSync(join(messagesRoot, locale, 'admin.json'), 'utf8')) as unknown
    for (const key of labelKeys) {
      const value = lookup(admin, key)
      if (typeof value !== 'string' || !value.trim()) missing.push(`${locale}: admin.${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

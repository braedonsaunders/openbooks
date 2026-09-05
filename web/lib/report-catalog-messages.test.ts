import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { REPORT_ENTITIES } from '@openbooks/reports'

/**
 * Every report entity and every one of its columns must have a heading.
 *
 * `reportRunLabels` (web/lib/report-labels.ts) resolves column headings with a
 * bare `t(\`catalog.columns.${entity}.${column}\`)` — no `t.has` guard and no
 * fallback — so a missing key renders the key PATH as the column heading, in
 * the report, in exports, and in the scheduled PDF. It is silent: nothing
 * throws, nothing logs, and it is only caught by someone opening that specific
 * report and reading the header row.
 *
 * Adding an entity or a column is therefore a two-file change, and this is what
 * says so at the point the second file is forgotten.
 */

const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const
type ReportsCatalog = {
  builtIns: Record<string, { name?: string; description?: string }>
  catalog: {
    entities: Record<string, unknown>
    columns: Record<string, Record<string, string>>
  }
}

const catalogs = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'messages', locale, 'reports.json'), 'utf8'),
  ) as ReportsCatalog,
])) as Record<(typeof LOCALES)[number], ReportsCatalog>

test('every report entity has a catalog label', () => {
  assert.ok(REPORT_ENTITIES.length > 0, 'no report entities were loaded — the import broke')
  const missing: string[] = []
  for (const locale of LOCALES) {
    for (const entity of REPORT_ENTITIES) {
      const entry = catalogs[locale].catalog.entities[entity.key] as { label?: unknown; description?: unknown } | undefined
      for (const field of ['label', 'description'] as const) {
        if (typeof entry?.[field] !== 'string' || !(entry[field] as string).trim()) {
          missing.push(`${locale}:catalog.entities.${entity.key}.${field}`)
        }
      }
    }
  }
  assert.deepEqual(missing, [], `entities with no label:\n${missing.join('\n')}`)
})

test('every report column has a heading, or the report renders its key path', () => {
  const missing: string[] = []
  for (const locale of LOCALES) {
    for (const entity of REPORT_ENTITIES) {
      const headings = catalogs[locale].catalog.columns[entity.key] ?? {}
      for (const column of entity.columns ?? []) {
        if (typeof headings[column.key] !== 'string' || !headings[column.key]!.trim()) {
          missing.push(`${locale}:catalog.columns.${entity.key}.${column.key}`)
        }
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these would render as raw key paths in the column header:\n${missing.join('\n')}`,
  )
})

test('every locale has complete lot-recall built-in copy', () => {
  const missing: string[] = []
  for (const locale of LOCALES) {
    const copy = catalogs[locale].builtIns['lot-recall']
    if (!copy?.name?.trim()) missing.push(`${locale}:builtIns.lot-recall.name`)
    if (!copy?.description?.trim()) missing.push(`${locale}:builtIns.lot-recall.description`)
  }
  assert.deepEqual(missing, [], `lot recall copy missing:\n${missing.join('\n')}`)
})

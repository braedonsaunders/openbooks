#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allReportEntities } from '@openbooks/reports'
import { LOCALES } from '../web/i18n/config.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function findMissingReportCatalogStrings(registeredEntities, catalogs) {
  const missing = []
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const reportCatalog = isRecord(catalog?.catalog) ? catalog.catalog : {}
    const entityLabels = isRecord(reportCatalog.entities) ? reportCatalog.entities : {}
    const columnLabels = isRecord(reportCatalog.columns) ? reportCatalog.columns : {}
    for (const { entity } of registeredEntities) {
      const labels = isRecord(entityLabels[entity.key]) ? entityLabels[entity.key] : {}
      for (const field of ['label', 'description']) {
        if (typeof labels[field] !== 'string' || !labels[field].trim()) {
          missing.push({ locale, key: `catalog.entities.${entity.key}.${field}` })
        }
      }
      const headings = isRecord(columnLabels[entity.key]) ? columnLabels[entity.key] : {}
      for (const column of entity.columns ?? []) {
        if (typeof headings[column.key] !== 'string' || !headings[column.key].trim()) {
          missing.push({ locale, key: `catalog.columns.${entity.key}.${column.key}` })
        }
      }
    }
  }
  return missing
}

function main() {
  const catalogs = Object.fromEntries(LOCALES.map(({ code }) => [
    code,
    JSON.parse(readFileSync(join(ROOT, 'web', 'messages', code, 'reports.json'), 'utf8')),
  ]))
  const registeredEntities = allReportEntities()
  const missing = findMissingReportCatalogStrings(registeredEntities, catalogs)
  if (missing.length > 0) {
    console.error(`Missing report catalog strings (${missing.length}):`)
    for (const { locale, key } of missing) console.error(`${locale}\t${key}`)
    process.exitCode = 1
    return
  }
  console.log(`Report catalog strings cover ${registeredEntities.length} entities in ${LOCALES.length} locales.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MESSAGES_DIR = join(import.meta.dirname, '..', 'messages')
export const FALLBACK_MANIFEST_PATH = join(MESSAGES_DIR, 'untranslated-fallbacks.json')
export const SOURCE_LOCALE = 'en'
export const PROPERTY_MANAGEMENT_PREFIX = 'entities.propertyManagement.'

export type FlatCatalog = Map<string, string>

export interface FallbackManifest {
  _generated: string
  sourceLocale: string
  fallbacks: Record<string, string[]>
}

export interface LocaleCompleteness {
  locale: string
  sourceKeys: number
  translated: number
  untranslated: number
  declaredFallbacks: number
  /** Keys carried by the locale that are no longer present in English. */
  extraKeys: string[]
  coverage: string
}

export function messageLocales(): string[] {
  return readdirSync(MESSAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function walkStrings(
  node: unknown,
  path: string[],
  visit: (path: string[], value: string) => void,
): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = [...path, key]
    if (typeof value === 'string') visit(keyPath, value)
    else walkStrings(value, keyPath, visit)
  }
}

export function flattenCatalog(locale: string): FlatCatalog {
  const flattened: FlatCatalog = new Map()
  for (const file of readdirSync(join(MESSAGES_DIR, locale)).filter((name) => name.endsWith('.json'))) {
    const namespace = file.slice(0, -'.json'.length)
    const messages = JSON.parse(readFileSync(join(MESSAGES_DIR, locale, file), 'utf8'))
    walkStrings(messages, [], (keyPath, value) => {
      flattened.set(`${namespace}.${keyPath.join('.')}`, value)
    })
  }
  return flattened
}

export function readFallbackManifest(): FallbackManifest {
  return JSON.parse(readFileSync(FALLBACK_MANIFEST_PATH, 'utf8')) as FallbackManifest
}

/**
 * I18N1 reviewed identicals: source-English values whose correct translation
 * is spelled exactly the same in that locale, so presence in the locale file
 * counts as translated and the key leaves the untranslated-fallback manifest.
 * Each entry is `locale:key|term` and pins the exact term: a rewording must
 * update the pin, and a removed key must leave this list. Reasons:
 * - German/Portuguese "Status", German "Code"/"Name", French
 *   "Code"/"Type"/"Charge"/"Description"/"Transaction"/"Date"/"Actions" and
 *   French accounting "Consolidation" are the ordinary nouns in those
 *   languages, already used verbatim across the shipped catalogs.
 * - `propertyManagement.detail.description` is placeholders plus a middle
 *   dot (`{subsidiary} · {location}`) — identical by construction in every
 *   locale, with no prose to translate.
 * - `assets.leases` German "Revision"/"Status", Portuguese "Status" and
 *   French "Description" are the same ordinary nouns, used for the same
 *   table headers in both languages.
 * - `revenue.modify` French "Description" is the same ordinary noun, used
 *   for the same form field in both languages.
 */
export const I18N1_IDENTICAL_BY_FACT: ReadonlySet<string> = new Set([
  'de:accounting.lifecycle.status|Status',
  'de:assets.leases.colRevision|Revision',
  'de:assets.leases.colStatus|Status',
  'de:assets.leases.revision|Revision',
  'fr:assets.leases.fieldDescription|Description',
  'fr:revenue.modify.fieldDescription|Description',
  'pt-BR:assets.leases.colStatus|Status',
  'de:entities.propertyManagement.detail.description|{subsidiary} · {location}',
  'de:entities.propertyManagement.detail.fields.name|Name',
  'de:entities.propertyManagement.detail.fields.status|Status',
  'de:entities.propertyManagement.detail.leases.table.status|Status',
  'de:entities.propertyManagement.detail.units.table.status|Status',
  'de:entities.propertyManagement.leaseSections.escalations.table.status|Status',
  'de:entities.propertyManagement.list.columns.code|Code',
  'de:entities.propertyManagement.list.columns.status|Status',
  'es:entities.propertyManagement.detail.description|{subsidiary} · {location}',
  'fr:accounting.lifecycle.description|Description',
  'fr:accounting.lifecycle.domains.consolidation|Consolidation',
  'fr:entities.propertyManagement.detail.actions|Actions',
  'fr:entities.propertyManagement.detail.description|{subsidiary} · {location}',
  'fr:entities.propertyManagement.detail.units.table.type|Type',
  'fr:entities.propertyManagement.leaseSections.charges.labels.description|Description',
  'fr:entities.propertyManagement.leaseSections.charges.labels.type|Type',
  'fr:entities.propertyManagement.leaseSections.charges.table.charge|Charge',
  'fr:entities.propertyManagement.leaseSections.deposits.labels.date|Date',
  'fr:entities.propertyManagement.leaseSections.deposits.labels.transaction|Transaction',
  'fr:entities.propertyManagement.list.columns.code|Code',
  'fr:entities.propertyManagement.list.columns.propertyType|Type',
  'ja:entities.propertyManagement.detail.description|{subsidiary} · {location}',
  'pt-BR:accounting.lifecycle.status|Status',
  'pt-BR:entities.propertyManagement.detail.description|{subsidiary} · {location}',
  'pt-BR:entities.propertyManagement.detail.fields.status|Status',
  'pt-BR:entities.propertyManagement.detail.leases.table.status|Status',
  'pt-BR:entities.propertyManagement.detail.units.table.status|Status',
  'pt-BR:entities.propertyManagement.leaseSections.escalations.table.status|Status',
  'pt-BR:entities.propertyManagement.list.columns.status|Status',
  'zh:entities.propertyManagement.detail.description|{subsidiary} · {location}',
])

function isReviewedIdentical(locale: string, key: string, value: string | undefined): boolean {
  return value !== undefined && I18N1_IDENTICAL_BY_FACT.has(`${locale}:${key}|${value}`)
}

/**
 * Generate the explicit inventory for the bulk property-management fallback.
 * Missing values and UNREVIEWED source-identical copies are both
 * untranslated. Copies pinned in I18N1_IDENTICAL_BY_FACT are reviewed
 * translations that happen to share English spelling, so they leave the
 * manifest. The guard test still rejects any identical copy outside that
 * list, so locale overlays use the runtime's real English fallback rather
 * than pretending unreviewed copies are translations.
 */
export function generateFallbackManifest(): FallbackManifest {
  const source = flattenCatalog(SOURCE_LOCALE)
  const propertyKeys = [...source.keys()]
    .filter((key) => key.startsWith(PROPERTY_MANAGEMENT_PREFIX))
    .sort()
  const fallbacks: Record<string, string[]> = {}

  for (const locale of messageLocales().filter((candidate) => candidate !== SOURCE_LOCALE)) {
    const catalog = flattenCatalog(locale)
    fallbacks[locale] = propertyKeys.filter(
      (key) =>
        !catalog.has(key) ||
        (catalog.get(key) === source.get(key) && !isReviewedIdentical(locale, key, catalog.get(key))),
    )
  }

  return {
    _generated: 'Run node --import tsx scripts/i18n-catalog-completeness.ts --write-manifest. Listed keys render from English and do not count as translated.',
    sourceLocale: SOURCE_LOCALE,
    fallbacks,
  }
}

export function completenessReport(manifest = readFallbackManifest()): LocaleCompleteness[] {
  const source = flattenCatalog(SOURCE_LOCALE)
  return messageLocales()
    .filter((locale) => locale !== SOURCE_LOCALE)
    .map((locale) => {
      const catalog = flattenCatalog(locale)
      const missing = [...source.keys()].filter((key) => !catalog.has(key))
      const extraKeys = [...catalog.keys()].filter((key) => !source.has(key)).sort()
      const declared = manifest.fallbacks[locale] ?? []
      const untranslated = new Set([...missing, ...declared]).size
      const translated = source.size - untranslated
      return {
        locale,
        sourceKeys: source.size,
        translated,
        untranslated,
        declaredFallbacks: declared.length,
        extraKeys,
        coverage: ((translated / source.size) * 100).toFixed(2),
      }
    })
}

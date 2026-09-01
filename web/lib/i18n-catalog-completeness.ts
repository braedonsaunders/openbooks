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
 * Generate the explicit inventory for the bulk property-management fallback.
 * Missing values and source-identical copies are both untranslated. The guard
 * test separately rejects source copies so locale overlays use the runtime's
 * real English fallback rather than pretending the copies are translations.
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
      (key) => !catalog.has(key) || catalog.get(key) === source.get(key),
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

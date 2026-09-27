// source-pin-contract: locale index registration — every catalog file present in a locale directory is imported by that locale's generated index, and every locale registers the same namespace set; subjects derived from the filesystem.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LOCALE_CODES as LOCALES } from "../i18n/config"

/**
 * A catalog file that exists but is not imported by its locale index is
 * INVISIBLE: next-intl never loads the namespace, and every key in it renders
 * as its own raw path on the page — `inbox.filters.all` instead of "All".
 * That shipped in v0.1.0-alpha.22. inbox.json was present in all seven
 * locales with every key correctly translated, and no index imported it, so
 * the unified inbox rendered raw key paths in production: a hand-maintained
 * list can only OMIT, and an omission is silent. So the indexes are generated
 * from the English directory. The filesystem is the source of truth for which
 * namespaces exist; the indexes must agree with it, and with each other.
 */
const REGENERATE = 'run node scripts/generate-locale-indexes.mjs'

const MESSAGES = join(process.cwd(), 'web', 'messages')

function catalogsOf(locale: string): string[] {
  return readdirSync(join(MESSAGES, locale))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

function importedBy(locale: string): string[] {
  const source = readFileSync(join(MESSAGES, locale, 'index.ts'), 'utf8')
  return [...source.matchAll(/from '\.\/([\w-]+)\.json'/g)].map((m) => m[1]!).sort()
}

test('every locale catalog file is imported by its index', () => {
  for (const locale of LOCALES) {
    const present = catalogsOf(locale)
    const imported = importedBy(locale)
    const unimported = present.filter((name) => !imported.includes(name))
    assert.deepEqual(
      unimported,
      [],
      `${locale}: these catalogs exist but no index imports them, so every key in them renders as a raw path (${REGENERATE}): ${unimported.join(', ')}`,
    )
    const missingFile = imported.filter((name) => !present.includes(name))
    assert.deepEqual(
      missingFile,
      [],
      `${locale}: the index imports catalogs that do not exist (${REGENERATE}): ${missingFile.join(', ')}`,
    )
  }
})

test('every locale ships the same set of catalogs as English', () => {
  const english = catalogsOf('en')
  for (const locale of LOCALES) {
    if (locale === 'en') continue
    const missing = english.filter((name) => !catalogsOf(locale).includes(name))
    assert.deepEqual(
      missing,
      [],
      `${locale} is missing catalogs English ships: ${missing.join(', ')}`,
    )
  }
})

test('the registered namespace set is identical across locales', () => {
  // A namespace registered in en but not in fr renders English for English
  // readers and a raw key for French ones -- the failure only reaches whoever
  // switched locale, which is the hardest audience to hear from.
  const reference = importedBy('en')
  for (const locale of LOCALES) {
    if (locale === 'en') continue
    assert.deepEqual(
      importedBy(locale),
      reference,
      `${locale}'s index registers a different namespace set than English (${REGENERATE})`,
    )
  }
})

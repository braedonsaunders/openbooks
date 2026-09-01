import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  PROPERTY_MANAGEMENT_PREFIX,
  completenessReport,
  flattenCatalog,
  generateFallbackManifest,
  readFallbackManifest,
} from './i18n-catalog-completeness.ts'

/**
 * Structural guards on the translation catalogs.
 *
 * These exist because the failure they catch is SILENT: the app renders the key
 * path itself ("payroll.wizard.readiness.codes.statutory.taxYear") in place of
 * the sentence, which reads as a rendering glitch rather than as a missing
 * translation, and nothing fails until somebody looks at that exact screen.
 */

const MESSAGES = join(import.meta.dirname, '..', 'messages')
const TAX_DEPRECIATION_PREFIX = 'admin.setup.taxDepreciationSetup.'

// Pin the English source text for this setup surface. If the source changes,
// this guard fails until every locale is reviewed instead of silently treating
// an old English translation as complete.
const TAX_DEPRECIATION_SOURCE_HASHES = {
  [`${TAX_DEPRECIATION_PREFIX}navTitle`]: 'f1920719940087cf0fdae8c5d4778b0abc3d267a387775229dc737bff5bc1365',
  [`${TAX_DEPRECIATION_PREFIX}title`]: 'f1920719940087cf0fdae8c5d4778b0abc3d267a387775229dc737bff5bc1365',
  [`${TAX_DEPRECIATION_PREFIX}description`]: '998dd3bd88bc4ffd1cad2f84b66017a70236de00f05502a1da7706219f273f75',
  [`${TAX_DEPRECIATION_PREFIX}tabsAria`]: '94eeff91e346811447f6d58a3e9197b3f8d09ab1d1c30a099a38c8af62d3e83d',
  [`${TAX_DEPRECIATION_PREFIX}tabs.overview`]: 'd4b1ea5708dd532930a85188b45aff6f0a3ed458500c7577e0127a538eb0d100',
  [`${TAX_DEPRECIATION_PREFIX}tabs.categories`]: 'b12da701a6bcf7667e6c85af588a6bdde243c3fccb3ca8ee058b7a5aaf6af5d9',
  [`${TAX_DEPRECIATION_PREFIX}tabs.regimes`]: '730858e5fd280e8842cdddb6ac0bcca5320b61150ee678d75d2026069d59cf90',
  [`${TAX_DEPRECIATION_PREFIX}tabs.classes`]: '702fbae523babcab808ad7be5f632cfab1da0818cacc4d72cd13ca85a947295a',
  [`${TAX_DEPRECIATION_PREFIX}tabs.firstYear`]: '8423728abea04b373c144693afbd277b539fdb1da1b156efa408ddfa0509553a',
  [`${TAX_DEPRECIATION_PREFIX}tabs.methods`]: '8696622f344183c4f73993a175acb8daa6418a5cc29099e5d2d762cba2d6f7f2',
  [`${TAX_DEPRECIATION_PREFIX}tabs.books`]: 'af74d3127b3ead60b876f475b99c2ae3d8f9d813607a8088d5762f40e8ab7f65',
  [`${TAX_DEPRECIATION_PREFIX}packsTitle`]: '7d30ca17c0cd199d4698fa17a8d129fd7d70f13129327716b90f515a3c2a0335',
  [`${TAX_DEPRECIATION_PREFIX}packsDescription`]: '44a65579459693f37529e523ab3bc1943e73bc01d7ebafbd08acc2dc0cbf5553',
  [`${TAX_DEPRECIATION_PREFIX}recommended`]: '802a1cf16d9b24f3a161d120bca13f3ed6a2d4dcf59d09186e322d3eafbf1a86',
  [`${TAX_DEPRECIATION_PREFIX}installed`]: 'f8b32f4e92bd84ce1fcd177bec17d43093de3ee8303bb40c1b9ea521ed6a70f6',
  [`${TAX_DEPRECIATION_PREFIX}install`]: 'f6e17928a4263827d9e129df3bf91823b82bd52f1cfc34228e3b1c19c1a1952f',
  [`${TAX_DEPRECIATION_PREFIX}installing`]: '530bcc355f0a3cd6a75a5216f1648e3dc48da5615ee41f56e033f4732982a3df',
  [`${TAX_DEPRECIATION_PREFIX}installFailed`]: 'd55ba36f797497fd246527878587428f4ec294d39d63aa7cdf307747c1c93536',
  [`${TAX_DEPRECIATION_PREFIX}installedToast`]: '1280cd9f26127763b4c89ae0eabd1c7ca729c669d72985fce2b0dfcd6c0c1bfb',
  [`${TAX_DEPRECIATION_PREFIX}assignmentFailed`]: '9a92dd9d757e9bbb897a427a7295950541d09bf9b9ff0fe9aa0007aaf00aafa7',
  [`${TAX_DEPRECIATION_PREFIX}assignmentsTitle`]: '37ce945efc5b3b686ef762d63bc2f9ad3932ac15024e847894d1e6a789031dc9',
  [`${TAX_DEPRECIATION_PREFIX}assignmentsDescription`]: 'daa05a967b00f231e480b625cf77abb87343de17c1331aacd8ec8c56e293fdad',
  [`${TAX_DEPRECIATION_PREFIX}assetCategory`]: '0c5241538a5aef97596c846b774c268be361bd18721cacdaaeba509b2bb96e01',
  [`${TAX_DEPRECIATION_PREFIX}notAssigned`]: '13075c2336114cd61689ea2ff249beb20052a0afbad7f0e4b8d68fb866e568e7',
  [`${TAX_DEPRECIATION_PREFIX}classCount`]: 'bbd7c9bfaf96833c0cb039be1014184e58b147b3a63a9e715d98ac38b73167ad',
  [`${TAX_DEPRECIATION_PREFIX}models.pool`]: '37ca1774001e21a29c2e17ee1cf760ac1ee671e1f0a1ab1f977d8f8e6c8cad02',
  [`${TAX_DEPRECIATION_PREFIX}models.macrs`]: 'f132869cd217b6a19c890f2e00ec339f3c7f0a92b3fbcf87fe518d8fe8ebd024',
  [`${TAX_DEPRECIATION_PREFIX}customizeTitle`]: 'c5276e27afba47df67704ededdb5cf2cfaaf0a9d7d1be1eabb0d4087dd2b724b',
  [`${TAX_DEPRECIATION_PREFIX}customizeDescription`]: 'b2951ee484a6f44271644beaa52e2fa999fa3f7e329ceaebff81262b3c73ff7f',
  [`${TAX_DEPRECIATION_PREFIX}links.regimes.title`]: '6f7bd73a7dda448e7b6c7579592935095e2da96502e849e1b980bcdc5eb35365',
  [`${TAX_DEPRECIATION_PREFIX}links.regimes.description`]: '77e583c9604b55fb2475ba2efbb4dda49f4af2382ead989038fa24574e1f9511',
  [`${TAX_DEPRECIATION_PREFIX}links.classes.title`]: 'ac156df6b94cb4845691032c3ffb9c8f97948413bf056ed75778ec5e9cb1dee4',
  [`${TAX_DEPRECIATION_PREFIX}links.classes.description`]: '5378bbce05cf58ee794dc973575fe34c0570bdaffc7e0e31acf2cc8a345db650',
  [`${TAX_DEPRECIATION_PREFIX}links.firstYear.title`]: '8423728abea04b373c144693afbd277b539fdb1da1b156efa408ddfa0509553a',
  [`${TAX_DEPRECIATION_PREFIX}links.firstYear.description`]: 'b1b3e75d46ab893e60493ed32b0c59b28b50d894bff044b70fba2c63153839b4',
  [`${TAX_DEPRECIATION_PREFIX}links.assignments.title`]: '1eef22e22236c7c8f78fcd80652f7d0c5b36330ceeb03fbeb0a00ef2fc68d1e7',
  [`${TAX_DEPRECIATION_PREFIX}links.assignments.description`]: '42ebcc26ce4f44ebf5a0f651b97841222828b51aa39186d074b32cf663acad57',
} as const

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isAsciiEnglishCopy(sourceValue: string, localizedValue: string): boolean {
  if (!/^[\x00-\x7f]*$/.test(localizedValue)) return false
  if (sourceValue.includes('{count, plural')) return false
  const sourceWords = new Set(sourceValue.toLowerCase().match(/[a-z]{3,}/g) ?? [])
  const localizedWords = localizedValue.toLowerCase().match(/[a-z]{3,}/g) ?? []
  if (localizedWords.length < 3) return false
  const overlap = localizedWords.filter((word) => sourceWords.has(word)).length / localizedWords.length
  return overlap >= 0.5
}

const locales = readdirSync(MESSAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const catalogs = locales.flatMap((locale) =>
  readdirSync(join(MESSAGES, locale))
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ locale, file, path: join(MESSAGES, locale, file) })),
)

const ASSET_REMEASUREMENT_KIND_KEYS = ['revalued', 'impaired', 'unknown'] as const
const REMEASURE_BUTTON_SOURCE = readFileSync(
  new URL('../app/(app)/assets/RemeasureButton.tsx', import.meta.url),
  'utf8',
)

/** Every key in a catalog, as the dotted path a caller would pass to `t()`. */
function walk(
  node: unknown,
  path: string[],
  visit: (key: string, path: string[], value: unknown) => void,
): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    visit(key, [...path, key], value)
    walk(value, [...path, key], visit)
  }
}

test('the catalogs are non-empty and every one parses', () => {
  assert.ok(locales.includes('en'), 'English is the source catalog and must exist')
  assert.ok(catalogs.length > 0, 'no message catalogs were found')
  for (const { path, file, locale } of catalogs) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(path, 'utf8')),
      `${locale}/${file} is not valid JSON`,
    )
  }
})

test('no message key contains a dot, because next-intl resolves dots by nesting', () => {
  // `t('a.b')` looks up `{ a: { b } }`, NEVER a literal `"a.b"` key. A flat
  // dotted key is therefore unreachable — it looks correct in the file, passes
  // review, and renders the raw path on screen. Two separate payroll slices
  // have shipped one; this is the check that stops the third.
  const offenders: string[] = []
  for (const { locale, file, path } of catalogs) {
    walk(JSON.parse(readFileSync(path, 'utf8')), [], (key, keyPath) => {
      if (key.includes('.')) offenders.push(`${locale}/${file}: ${keyPath.join('.')}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `these keys can never be resolved — nest them instead:\n${offenders.join('\n')}`,
  )
})

test('no message value is an empty string', () => {
  // An empty string is indistinguishable from a rendered-but-blank label, and
  // next-intl treats it as present, so the English fallback never fires.
  const blanks: string[] = []
  for (const { locale, file, path } of catalogs) {
    walk(JSON.parse(readFileSync(path, 'utf8')), [], (_key, keyPath, value) => {
      if (typeof value === 'string' && value.trim() === '') {
        blanks.push(`${locale}/${file}: ${keyPath.join('.')}`)
      }
    })
  }
  assert.deepEqual(blanks, [], `these keys resolve to nothing:\n${blanks.join('\n')}`)
})

test('every assets catalog matches English and has localized remeasurement result labels', () => {
  const source = flattenCatalog('en')
  const sourceKeys = [...source.keys()].filter((key) => key.startsWith('assets.')).sort()

  for (const locale of locales) {
    const catalog = flattenCatalog(locale)
    const assetKeys = [...catalog.keys()].filter((key) => key.startsWith('assets.')).sort()
    assert.deepEqual(
      assetKeys,
      sourceKeys,
      `${locale}/assets.json must contain exactly the English assets key structure`,
    )

    for (const kind of ASSET_REMEASUREMENT_KIND_KEYS) {
      const key = `assets.remeasure.kinds.${kind}`
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale}/assets.json is missing ${key}`)
      assert.notEqual(value, kind, `${locale}/assets.json must localize ${key}`)
      if (locale !== 'en') {
        assert.notEqual(value, source.get(key), `${locale}/assets.json must not copy English ${key}`)
      }
    }
  }
})

test('remeasurement result kinds are allow-listed before translation', () => {
  assert.match(REMEASURE_BUTTON_SOURCE, /switch \(kind\)/)
  assert.match(REMEASURE_BUTTON_SOURCE, /case 'revalued':\s+return 'revalued'/)
  assert.match(REMEASURE_BUTTON_SOURCE, /case 'impaired':\s+return 'impaired'/)
  assert.match(REMEASURE_BUTTON_SOURCE, /default:\s+return 'unknown'/)
  assert.match(
    REMEASURE_BUTTON_SOURCE,
    /t\(`remeasure\.kinds\.\$\{remeasurementKindKey\(d\.kind\)\}`\)/,
  )
  assert.doesNotMatch(REMEASURE_BUTTON_SOURCE, /kind: d\.kind/)
})

test('the generated fallback manifest exactly identifies untranslated property-management copy', () => {
  const source = flattenCatalog('en')
  const manifest = readFallbackManifest()
  const translatedLocales = locales.filter((locale) => locale !== 'en').sort()
  const propertyKeys = [...source.keys()]
    .filter((key) => key.startsWith(PROPERTY_MANAGEMENT_PREFIX))
    .sort()

  assert.equal(manifest.sourceLocale, 'en')
  assert.deepEqual(Object.keys(manifest.fallbacks).sort(), translatedLocales)
  assert.equal(propertyKeys.length, 178, 'the property-management source inventory changed')
  assert.deepEqual(manifest, generateFallbackManifest(), 'fallback manifest must be regenerated')

  for (const locale of translatedLocales) {
    const catalog = flattenCatalog(locale)
    const listed = manifest.fallbacks[locale] ?? []
    const copiedEnglish = propertyKeys.filter(
      (key) => catalog.has(key) && catalog.get(key) === source.get(key),
    )
    const missing = propertyKeys.filter((key) => !catalog.has(key))

    assert.deepEqual(
      copiedEnglish,
      [],
      `${locale} contains source-English property copy that would be counted as translated`,
    )
    assert.deepEqual(listed, [...new Set(listed)].sort(), `${locale} fallback keys must be unique and sorted`)
    assert.deepEqual(
      listed,
      missing,
      `${locale} fallback manifest must exactly match untranslated property-management keys`,
    )
  }
})

test('tax-depreciation translations cover the pinned source and reject English drift', () => {
  const source = flattenCatalog('en')
  const sourceKeys = [...source.keys()]
    .filter((key) => key.startsWith(TAX_DEPRECIATION_PREFIX))
    .sort()
  const pinnedKeys = Object.keys(TAX_DEPRECIATION_SOURCE_HASHES).sort()

  assert.deepEqual(
    sourceKeys,
    pinnedKeys,
    'tax-depreciation source inventory changed; review translations and update source hashes',
  )

  const changedSource = sourceKeys.filter(
    (key) => sha256(source.get(key) ?? '') !== TAX_DEPRECIATION_SOURCE_HASHES[key as keyof typeof TAX_DEPRECIATION_SOURCE_HASHES],
  )
  assert.deepEqual(
    changedSource,
    [],
    'tax-depreciation English copy changed; review every locale before updating the pinned hashes',
  )

  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    const missing = sourceKeys.filter((key) => !catalog.has(key))
    const copiedEnglish = sourceKeys.filter(
      (key) => catalog.get(key) === source.get(key),
    )
    const staleEnglish = sourceKeys.filter((key) => {
      const sourceValue = source.get(key)
      const localizedValue = catalog.get(key)
      return sourceValue !== undefined && localizedValue !== undefined && isAsciiEnglishCopy(sourceValue, localizedValue)
    })

    assert.deepEqual(missing, [], `${locale} is missing tax-depreciation translations`)
    assert.deepEqual(
      copiedEnglish,
      [],
      `${locale} contains source-English tax-depreciation copy that would be counted as translated`,
    )
    assert.deepEqual(
      staleEnglish,
      [],
      `${locale} contains stale ASCII-only English tax-depreciation prose`,
    )
  }
})

test('localized overhead settings use the current source keys after the burden rename', () => {
  const source = flattenCatalog('en')
  const renamedKeys = [
    ['projectTypes.burdenSource', 'projectTypes.overheadSource'],
    ['projectTypes.burdenDimension', 'projectTypes.overheadDimension'],
    ['admin.setup.entities.labor-burden-rates.title', 'admin.setup.entities.overhead-rates.title'],
    ['admin.setup.entities.labor-burden-rates.description', 'admin.setup.entities.overhead-rates.description'],
    ['admin.setup.options.burdenMethod.live', 'admin.setup.options.overheadMethod.live'],
    ['admin.setup.options.burdenMethod.standard', 'admin.setup.options.overheadMethod.standard'],
  ] as const
  const requiredKeys = [
    'projectTypes.overheadSource',
    'projectTypes.overheadDimension',
    'projectTypes.overheadMethod',
    'projectTypes.overheadRatePercent',
    'projectTypes.overheadRatePerHour',
    'projectTypes.overheadRateSource',
    'projectTypes.overheadHoursBasis',
    'projectTypes.overheadScope',
    'projectTypes.overheadRateEngineHint',
    'admin.setup.entities.overhead-rates.title',
    'admin.setup.entities.overhead-rates.description',
    'admin.setup.entities.overhead-rates.singular',
    'admin.setup.options.overheadMethod.live',
    'admin.setup.options.overheadMethod.standard',
  ] as const

  for (const locale of ['zh', 'de', 'pt-BR', 'ja']) {
    const catalog = flattenCatalog(locale)
    const staleKeys = renamedKeys
      .map(([legacy]) => legacy)
      .filter((key) => catalog.has(key))
    const missingKeys = requiredKeys
      .filter((key) => !catalog.has(key) || !source.has(key))

    assert.deepEqual(staleKeys, [], `${locale} still carries dead pre-rename overhead keys`)
    assert.deepEqual(missingKeys, [], `${locale} is missing live overhead translation keys`)
  }
})

test('catalog completeness counts missing and declared fallback keys as untranslated', (t) => {
  const source = flattenCatalog('en')
  const manifest = readFallbackManifest()

  for (const row of completenessReport(manifest)) {
    assert.deepEqual(
      row.extraKeys,
      [],
      `${row.locale} contains keys absent from the English source: ${row.extraKeys.join(', ')}`,
    )
    const declaredFallbacks = manifest.fallbacks[row.locale] ?? []
    for (const key of declaredFallbacks) {
      assert.ok(source.has(key), `${row.locale} fallback key is absent from English source: ${key}`)
    }
    assert.equal(
      declaredFallbacks.filter((key) => key.startsWith(PROPERTY_MANAGEMENT_PREFIX)).length,
      178,
      `${row.locale} must report all property-management values as untranslated fallbacks`,
    )
    t.diagnostic(
      `${row.locale}: translated=${row.translated}/${row.sourceKeys} untranslated=${row.untranslated} ` +
      `declaredFallbacks=${row.declaredFallbacks} coverage=${row.coverage}%`,
    )
  }
})

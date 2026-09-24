import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  I18N1_IDENTICAL_BY_FACT,
  PROPERTY_MANAGEMENT_PREFIX,
  completenessReport,
  flattenCatalog,
  generateFallbackManifest,
  readFallbackManifest,
} from './i18n-catalog-completeness.ts'
import { PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import { COUNTRY_TAX_PACKS } from '@openbooks/engine/src/country-tax-packs/index.ts'

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
const ASSET_TAX_LABEL_KEYS = [
  'taxPools.configure',
  'taxPools.regime',
  'drawer.taxDepreciation',
  'drawer.taxCategoryDefault',
  'drawer.notAssigned',
  'drawer.taxClass',
  'drawer.useCategoryDefault',
  'drawer.businessUsePercent',
  'drawer.section179',
  'drawer.bonusPercent',
] as const
type AssetTaxLabelKey = (typeof ASSET_TAX_LABEL_KEYS)[number]

/** Reviewed financial terminology for every supported translation locale. */
const ASSET_TAX_LABEL_EXPECTATIONS: Record<string, Record<AssetTaxLabelKey, string>> = {
  de: {
    'taxPools.configure': 'Konfigurieren',
    'taxPools.regime': 'Steuerregime',
    'drawer.taxDepreciation': 'Steuerliche Abschreibung',
    'drawer.taxCategoryDefault': 'Standardwert der Kategorie: {value}',
    'drawer.notAssigned': 'Nicht zugeordnet',
    'drawer.taxClass': 'Steuerklasse',
    'drawer.useCategoryDefault': 'Standardwert der Kategorie verwenden',
    'drawer.businessUsePercent': 'Betriebliche Nutzung (%)',
    'drawer.section179': 'Wahlrecht nach § 179',
    'drawer.bonusPercent': 'Sonderabschreibung (%)',
  },
  es: {
    'taxPools.configure': 'Configurar',
    'taxPools.regime': 'Régimen fiscal',
    'drawer.taxDepreciation': 'Depreciación fiscal',
    'drawer.taxCategoryDefault': 'Valor predeterminado de la categoría: {value}',
    'drawer.notAssigned': 'Sin asignar',
    'drawer.taxClass': 'Clase fiscal',
    'drawer.useCategoryDefault': 'Usar el valor predeterminado de la categoría',
    'drawer.businessUsePercent': 'Uso empresarial (%)',
    'drawer.section179': 'Elección de la Sección 179',
    'drawer.bonusPercent': 'Depreciación adicional (%)',
  },
  fr: {
    'taxPools.configure': 'Configurer',
    'taxPools.regime': 'Régime fiscal',
    'drawer.taxDepreciation': 'Amortissement fiscal',
    'drawer.taxCategoryDefault': 'Valeur par défaut de la catégorie : {value}',
    'drawer.notAssigned': 'Non affecté',
    'drawer.taxClass': 'Classe fiscale',
    'drawer.useCategoryDefault': 'Utiliser la valeur par défaut de la catégorie',
    'drawer.businessUsePercent': 'Usage professionnel (%)',
    'drawer.section179': 'Option de la section 179',
    'drawer.bonusPercent': 'Amortissement bonifié (%)',
  },
  ja: {
    'taxPools.configure': '設定',
    'taxPools.regime': '税制',
    'drawer.taxDepreciation': '税務減価償却',
    'drawer.taxCategoryDefault': 'カテゴリの既定値: {value}',
    'drawer.notAssigned': '未割り当て',
    'drawer.taxClass': '税務クラス',
    'drawer.useCategoryDefault': 'カテゴリの既定値を使用',
    'drawer.businessUsePercent': '事業使用率（%）',
    'drawer.section179': 'セクション179の選択',
    'drawer.bonusPercent': '特別償却（%）',
  },
  'pt-BR': {
    'taxPools.configure': 'Configurar',
    'taxPools.regime': 'Regime fiscal',
    'drawer.taxDepreciation': 'Depreciação fiscal',
    'drawer.taxCategoryDefault': 'Valor padrão da categoria: {value}',
    'drawer.notAssigned': 'Não atribuído',
    'drawer.taxClass': 'Classe fiscal',
    'drawer.useCategoryDefault': 'Usar o valor padrão da categoria',
    'drawer.businessUsePercent': 'Uso empresarial (%)',
    'drawer.section179': 'Opção da Seção 179',
    'drawer.bonusPercent': 'Depreciação adicional (%)',
  },
  zh: {
    'taxPools.configure': '配置',
    'taxPools.regime': '税制',
    'drawer.taxDepreciation': '税务折旧',
    'drawer.taxCategoryDefault': '类别默认值：{value}',
    'drawer.notAssigned': '未分配',
    'drawer.taxClass': '税类',
    'drawer.useCategoryDefault': '使用类别默认值',
    'drawer.businessUsePercent': '业务用途（%）',
    'drawer.section179': '第179条选择',
    'drawer.bonusPercent': '额外折旧（%）',
  },
}
const INVENTORY_VIEW_TAB_KEYS = ['view.onhand', 'view.movements', 'view.locations', 'view.bom'] as const
type InventoryViewTabKey = (typeof INVENTORY_VIEW_TAB_KEYS)[number]

/** Reviewed inventory workspace tab labels for every supported translation locale. */
const INVENTORY_VIEW_TAB_EXPECTATIONS: Record<string, Record<InventoryViewTabKey, string>> = {
  de: {
    'view.onhand': 'Bestand',
    'view.movements': 'Bewegungen',
    'view.locations': 'Lagerorte',
    'view.bom': 'Stückliste',
  },
  es: {
    'view.onhand': 'Existencias',
    'view.movements': 'Movimientos',
    'view.locations': 'Ubicaciones',
    'view.bom': 'Lista de materiales',
  },
  fr: {
    'view.onhand': 'En stock',
    'view.movements': 'Mouvements',
    'view.locations': 'Emplacements de stock',
    'view.bom': 'Nomenclature',
  },
  ja: {
    'view.onhand': '手持在庫',
    'view.movements': '変動',
    'view.locations': '保管場所',
    'view.bom': '部品表',
  },
  'pt-BR': {
    'view.onhand': 'Disponível',
    'view.movements': 'Movimentações',
    'view.locations': 'Locais de estoque',
    'view.bom': 'Lista de materiais',
  },
  zh: {
    'view.onhand': '在库',
    'view.movements': '变动',
    'view.locations': '库位',
    'view.bom': '物料清单',
  },
}

/**
 * Reviewed "Default form" labels (F-t02-013: the seeded built-in form name
 * leaked English into localized drawers). The drawers render this key only
 * for the default layout that still carries the seed name; a renamed default
 * or a same-named custom layout shows its stored name.
 */
const DEFAULT_FORM_NAME_EXPECTATIONS: Record<string, string> = {
  en: 'Default form',
  de: 'Standardformular',
  es: 'Formulario predeterminado',
  fr: 'Formulaire par défaut',
  ja: '既定のフォーム',
  'pt-BR': 'Formulário padrão',
  zh: '默认表单',
}

/**
 * Reviewed Spanish shared status labels (F-t02-014: "Factura … Aprobado"
 * disagreed in gender). The shared common.status labels cannot know their
 * noun, so the inflecting participles use gender-neutral o/a forms; the
 * invariant noun phrases (draft, pendingApproval) and non-words (error, ok)
 * stay untouched. Other locales keep their current reviewed values, pinned
 * here so a regression of the filed key is caught in every locale.
 */
const ES_NEUTRAL_STATUS_EXPECTATIONS: Record<string, string> = {
  'status.draft': 'Borrador',
  'status.pendingApproval': 'Pendiente de aprobación',
  'status.approved': 'Aprobado/a',
  'status.rejected': 'Rechazado/a',
  'status.posted': 'Contabilizado/a',
  'status.paid': 'Pagado/a',
  'status.partiallyPaid': 'Pagado/a parcialmente',
  'status.open': 'Abierto/a',
  'status.closed': 'Cerrado/a',
  'status.voided': 'Anulado/a',
  'status.reversed': 'Revertido/a',
  'status.cancelled': 'Cancelado/a',
  'status.active': 'Activo/a',
  'status.inactive': 'Inactivo/a',
  'status.error': 'Error',
  'status.ok': 'OK',
  'status.pending_approval': 'Enviado/a',
  'status.calculated': 'Calculado/a',
  'status.committed': 'Confirmado/a',
  'status.retired': 'Retirado/a',
}

/** The filed agreement key, pinned in every locale. */
const STATUS_APPROVED_EXPECTATIONS: Record<string, string> = {
  en: 'Approved',
  de: 'Genehmigt',
  es: 'Aprobado/a',
  fr: 'Approuvé',
  ja: '承認済み',
  'pt-BR': 'Aprovado',
  zh: '已批准',
}
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

test('fixed-asset tax labels are structurally complete and semantically localized', () => {
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

    const expectations = locale === 'en' ? undefined : ASSET_TAX_LABEL_EXPECTATIONS[locale]
    if (locale !== 'en') assert.ok(expectations, `${locale}/assets.json has no reviewed tax-label expectations`)

    for (const key of ASSET_TAX_LABEL_KEYS) {
      const fullKey = `assets.${key}`
      const value = catalog.get(fullKey)
      assert.ok(value && value.trim(), `${locale}/assets.json is missing ${fullKey}`)
      if (locale === 'en') {
        assert.equal(value, source.get(fullKey), `${fullKey} must match the English source`)
      } else {
        assert.equal(value, expectations?.[key], `${locale}/assets.json has an unreviewed ${fullKey}`)
        assert.notEqual(value, source.get(fullKey), `${locale}/assets.json must localize ${fullKey}`)
      }
    }
  }
})

test('inventory workspace tabs are translated in every locale', () => {
  const source = flattenCatalog('en')

  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    const expectations = INVENTORY_VIEW_TAB_EXPECTATIONS[locale]
    assert.ok(expectations, `${locale}/inventory.json has no reviewed tab expectations`)

    for (const key of INVENTORY_VIEW_TAB_KEYS) {
      const fullKey = `inventory.${key}`
      const value = catalog.get(fullKey)
      assert.ok(value && value.trim(), `${locale}/inventory.json is missing ${fullKey}`)
      assert.equal(value, expectations[key], `${locale}/inventory.json has an unreviewed ${fullKey}`)
      assert.notEqual(value, source.get(fullKey), `${locale}/inventory.json must localize ${fullKey}`)
    }
  }
})

test('property-management workspace chrome ships in every locale', () => {
  // F-t09-015: /property-management rendered fully English under fr/es —
  // the whole workspace block (heading, KPIs, tabs, actions, toasts) was
  // absent outside en and fell back to English. Every leaf must exist, be
  // localized, and keep its ICU placeholders.
  const source = flattenCatalog('en')
  const prefix = 'entities.propertyManagement.workspace.'
  const sourceKeys = [...source.keys()].filter((key) => key.startsWith(prefix)).sort()
  assert.ok(sourceKeys.length > 0, 'no workspace source keys')
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of sourceKeys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
    const tokens = (value: string): Set<string> =>
      new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
    const drift = sourceKeys.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} property-management translations drop ICU placeholders`)
  }
})

test('property buildings list copy ships localized in every locale', () => {
  // F-t09-017: the buildings table headers and type/status cells rendered
  // hardcoded English under fr — the list namespace was absent outside en.
  // Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const manifest = readFallbackManifest()
  const prefix = 'entities.propertyManagement.list.'
  const sourceKeys = [...source.keys()].filter((key) => key.startsWith(prefix)).sort()
  assert.ok(sourceKeys.length > 0, 'no buildings list source keys')
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    // Cognates spelled as in English are either omitted into the declared
    // fallback manifest (rendering from English at runtime) or — since
    // I18N1 — shipped in the locale file and pinned exactly in
    // I18N1_IDENTICAL_BY_FACT. Never copied as fake translations.
    const declared = new Set(manifest.fallbacks[locale] ?? [])
    for (const key of sourceKeys) {
      if (declared.has(key)) continue
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...I18N1_IDENTICAL_BY_FACT].find((entry) =>
        entry.startsWith(`${locale}:${key}|`),
      )
      if (identical) {
        assert.equal(value, identical.slice(identical.indexOf('|') + 1), `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
      }
    }
  }
})

test('property status labels ship localized in every locale', () => {
  // F-t09-017: the status badge read raw English (active) — the status
  // vocabulary gains active/inactive beside sold, localized everywhere.
  const source = flattenCatalog('en')
  const keys = ['customization.property.status.active', 'customization.property.status.inactive']
  // French Active/Inactive are spelled as in English: presence is required,
  // divergence is not.
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (locale !== 'fr') {
        assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
      }
    }
  }
})

test('setup save-failure copy ships localized in every locale', () => {
  // F-t09-016: the overlap conflict and the save-timeout guidance render from
  // these keys — absent outside en they fall back to English inside otherwise
  // translated drawers. Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = ['admin.setup.errors.overlap', 'admin.setup.errors.saveTimedOut']
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('tax recoverable-percent refusal copy ships localized in every locale', () => {
  // F-t10-001: an out-of-range Recoverable % rendered the raw
  // `invalid-recoverable-percent` key in the dialog. Every leaf must exist
  // and be localized.
  const source = flattenCatalog('en')
  const keys = ['admin.setup.errors.invalidRecoverablePercent']
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('project rate-card lapse label ships localized in every locale', () => {
  // F-t11-002: the project-type Invoicing tab read projectTypes.rateCardLapse
  // while the sentence lives at projects.invoicing.rateCardLapse. The editor
  // reuses that key, so it must stay present and localized.
  const source = flattenCatalog('en')
  const keys = ['projects.invoicing.rateCardLapse']
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('book-policy custom-formula label ships localized in every locale', () => {
  // F-t11-006: the book-policy Method control rendered the raw
  // admin.setup.fields.depreciationMethodId key as its section label. Every
  // leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = ['admin.setup.fields.depreciationMethodId']
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('the seeded default-form label is translated in every locale', () => {
  const source = flattenCatalog('en')
  assert.equal(source.get('common.labels.defaultForm'), DEFAULT_FORM_NAME_EXPECTATIONS.en)

  for (const locale of locales) {
    const catalog = flattenCatalog(locale)
    const expected = DEFAULT_FORM_NAME_EXPECTATIONS[locale]
    assert.ok(expected, `${locale} has no reviewed default-form expectation`)
    const value = catalog.get('common.labels.defaultForm')
    assert.ok(value && value.trim(), `${locale}/common.json is missing common.labels.defaultForm`)
    assert.equal(value, expected, `${locale}/common.json has an unreviewed common.labels.defaultForm`)
  }
})

test('spanish shared status labels use gender-neutral forms', () => {
  const source = flattenCatalog('en')
  const catalog = flattenCatalog('es')

  for (const [key, expected] of Object.entries(ES_NEUTRAL_STATUS_EXPECTATIONS)) {
    const fullKey = `common.${key}`
    assert.ok(source.has(fullKey), `English source is missing ${fullKey}`)
    const value = catalog.get(fullKey)
    assert.ok(value && value.trim(), `es/common.json is missing ${fullKey}`)
    assert.equal(value, expected, `es/common.json has an unreviewed ${fullKey}`)
  }
  // No other Spanish status key may exist outside the reviewed set: a new
  // masculine participle would reintroduce the filed disagreement silently.
  const esStatusKeys = [...catalog.keys()].filter((key) => key.startsWith('common.status.')).sort()
  assert.deepEqual(esStatusKeys, Object.keys(ES_NEUTRAL_STATUS_EXPECTATIONS).map((key) => `common.${key}`).sort())
})

test('the filed agreement key is pinned in every locale', () => {
  for (const locale of locales) {
    const catalog = flattenCatalog(locale)
    const expected = STATUS_APPROVED_EXPECTATIONS[locale]
    assert.ok(expected, `${locale} has no reviewed status.approved expectation`)
    const value = catalog.get('common.status.approved')
    assert.ok(value && value.trim(), `${locale}/common.json is missing common.status.approved`)
    assert.equal(value, expected, `${locale}/common.json has an unreviewed common.status.approved`)
  }
})

test('partyless-control post warning ships localized in every locale', () => {
  // F-t08-007: the drawer pins this warning when a journal posts control
  // legs with no party — absent outside en it falls back to English inside
  // otherwise translated drawers. The {accounts} interpolation must survive
  // in every locale.
  const key = 'journal.drawer.partylessControlWarning'
  const source = flattenCatalog('en')
  assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    const value = catalog.get(key)
    assert.ok(value && value.trim(), `${locale} is missing ${key}`)
    assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    assert.ok(value.includes('{accounts}'), `${locale} must keep the {accounts} interpolation`)
  }
})

test('row-post grant label ships localized in every locale', () => {
  // UX-09: the document list row renders a disabled Post naming the required
  // grant — absent outside en it falls back to English inside otherwise
  // translated lists. The {permission} interpolation must survive in every
  // locale.
  const key = 'common.actions.postRequiresPermission'
  const source = flattenCatalog('en')
  assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    const value = catalog.get(key)
    assert.ok(value && value.trim(), `${locale} is missing ${key}`)
    assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    assert.ok(value.includes('{permission}'), `${locale} must keep the {permission} interpolation`)
  }
})

test('psp settlement import copy ships localized in every locale', () => {
  // UX-18: the settlement import form labels its account pickers by posting
  // role, explains each one, and refuses mis-shaped payloads by name —
  // absent outside en they fall back to English inside otherwise translated
  // banking screens. Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = [
    'banking.pspSettlements.bankAccountId',
    'banking.pspSettlements.bankAccountHint',
    'banking.pspSettlements.feeAccountId',
    'banking.pspSettlements.feeAccountHint',
    'banking.pspSettlements.clearingAccountId',
    'banking.pspSettlements.clearingAccountHint',
    'banking.pspSettlements.genericPayloadHint',
    'banking.pspSettlements.accountPlaceholder',
    'banking.pspSettlements.uploadPayload',
    'banking.pspSettlements.invalidStripePayload',
    'banking.pspSettlements.invalidGenericPayload',
  ]
  for (const key of keys) assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('sample-company failure copy ships localized in every locale', () => {
  // SC-RESUME: the provisioning API reports failures by pipeline stage and
  // the wizard renders the matching localized copy — absent outside en the
  // operator reads English inside an otherwise translated import screen, and
  // (worse) a stale translation can still claim "nothing was created" while
  // a resumable company exists. Every leaf must exist and be localized, and
  // the late-stage leaves must not make the nothing-created claim.
  const source = flattenCatalog('en')
  const keys = [
    'data.import.sample.createFailed',
    'data.import.sample.createFailedTemplate',
    'data.import.sample.createFailedClone',
    'data.import.sample.createFailedFinalize',
    'data.import.sample.createFailedNumbering',
  ]
  for (const key of keys) assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
    for (const key of [
      'data.import.sample.createFailedFinalize',
      'data.import.sample.createFailedNumbering',
    ]) {
      const value = catalog.get(key) ?? ''
      assert.ok(
        !/nothing was created|es wurde nichts erstellt|no se creó nada|rien n[’']a été créé|何も作成されていない|nada foi criado|未创建任何内容/i.test(value),
        `${locale} ${key} must not claim nothing was created for a resumable company`,
      )
    }
  }
  for (const key of [
    'data.import.sample.createFailedFinalize',
    'data.import.sample.createFailedNumbering',
  ]) {
    assert.doesNotMatch(
      source.get(key) ?? '',
      /nothing was created/i,
      `en ${key} must not claim nothing was created for a resumable company`,
    )
  }
})

test('sftp unbound-schedule paused copy ships localized in every locale', () => {
  // U7: an unbound identifying schedule reads "Paused: expected account not
  // set" with a remedy hint — absent outside en it falls back to English
  // inside otherwise translated Bank Feeds cards. Every leaf must exist and
  // be localized.
  const source = flattenCatalog('en')
  const keys = [
    'banking.bankFeeds.client.sftpCard.bindingPaused',
    'banking.bankFeeds.client.sftpCard.bindingPausedHint',
  ]
  for (const key of keys) assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('journal memo/reference hints ship localized in every locale', () => {
  // UX-18: the journal drawer explains Reference vs Memo beside each field —
  // absent outside en they fall back to English inside otherwise translated
  // drawers. Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = ['journal.drawer.referenceNumberHint', 'journal.drawer.memoHint']
  for (const key of keys) assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('setup wizard selection copy ships localized in every locale', () => {
  // UX-19: the company step states its combobox selections as live text and
  // the review step badges click-through defaults — absent outside en they
  // fall back to English inside otherwise translated wizards. The
  // {country}/{currency}/{fiscalMonth} interpolations must survive in every
  // locale.
  const source = flattenCatalog('en')
  const keys = [
    'admin.setup.wizard.company.selectedSummary',
    'admin.setup.wizard.review.defaultBadge',
    'admin.setup.wizard.review.defaultsHint',
  ]
  for (const key of keys) assert.ok(source.get(key), `en is missing ${key}`)
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
  for (const locale of locales) {
    const summary = flattenCatalog(locale).get('admin.setup.wizard.company.selectedSummary') ?? ''
    for (const token of ['{country}', '{currency}', '{fiscalMonth}', '{timeZone}']) {
      assert.ok(summary.includes(token), `${locale} must keep the ${token} interpolation`)
    }
  }
})

test('pack-declared tax filing notices resolve localized in every locale', () => {
  // F-w4-001: the generic prepare panel branched on the literal `CA_GST34`
  // code because packs had no notice channel. Packs now declare a
  // `tax`-namespace catalog key instead — and an untranslated key renders as
  // its raw path, so every declared key must exist and be localized. Keys
  // derive from the packs (not a pinned list) so a new pack notice without
  // translations fails, and removing the last declaration fails too.
  const keys = COUNTRY_TAX_PACKS.flatMap((pack) =>
    pack.returnPacks.flatMap((form) => (form.noticeKey ? [`tax.${form.noticeKey}`] : [])),
  )
  assert.ok(keys.length > 0, 'at least one return pack must declare a filing notice')
  const source = flattenCatalog('en')
  for (const key of keys) {
    assert.ok(source.get(key), `en is missing pack-declared ${key}`)
  }
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing pack-declared ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize pack-declared ${key}`)
    }
  }
})

test('mark-filed refusal copy ships localized in every locale', () => {
  // F-x5-001: the period-not-closed remedy renders from these keys — absent
  // outside en it falls back to English inside otherwise translated drawers.
  // Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = ['tax.history.errors.periodNotClosed', 'tax.history.errors.alreadyFiled', 'tax.history.errors.stale']
  for (const key of keys) {
    assert.ok(source.get(key), `en is missing ${key}`)
  }
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
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
  assert.equal(propertyKeys.length, 235, 'the property-management source inventory changed')
  assert.deepEqual(manifest, generateFallbackManifest(), 'fallback manifest must be regenerated')

  for (const locale of translatedLocales) {
    const catalog = flattenCatalog(locale)
    const listed = manifest.fallbacks[locale] ?? []
    // Reviewed identicals (I18N1_IDENTICAL_BY_FACT) are pinned translations
    // that share English spelling — only UNREVIEWED copies pretend.
    const copiedEnglish = propertyKeys.filter(
      (key) =>
        catalog.has(key) &&
        catalog.get(key) === source.get(key) &&
        !I18N1_IDENTICAL_BY_FACT.has(`${locale}:${key}|${catalog.get(key)}`),
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
    // Per-locale pins: I18N1 backfilled the last property-management gaps
    // (F-t09-017 fallbacks plus the F-i10 leaseSections/detail remainder) as
    // real translations. Genuine cognates now ship IN the locale files and
    // are pinned exactly in I18N1_IDENTICAL_BY_FACT instead of being omitted
    // into declared fallbacks — so every locale reports zero remaining
    // property-management fallbacks.
    const expectedPmFallbacks: Record<string, number> = {
      de: 0,
      es: 0,
      fr: 0,
      ja: 0,
      'pt-BR': 0,
      zh: 0,
    }
    assert.equal(
      declaredFallbacks.filter((key) => key.startsWith(PROPERTY_MANAGEMENT_PREFIX)).length,
      expectedPmFallbacks[row.locale],
      `${row.locale} must report all property-management values as untranslated fallbacks`,
    )
    t.diagnostic(
      `${row.locale}: translated=${row.translated}/${row.sourceKeys} untranslated=${row.untranslated} ` +
      `declaredFallbacks=${row.declaredFallbacks} coverage=${row.coverage}%`,
    )
  }
})

test('admin user invite copy is present in every locale and translated', () => {
  // The Users page invite drawer (F-t01-013) renders these keys; a missing
  // key shows the raw path and an English paste ships as a rendering glitch.
  const keys = [
    'admin.users.statusPending',
    'admin.users.inviteButton',
    'admin.users.inviteTitle',
    'admin.users.inviteDescription',
    'admin.users.inviteEmailLabel',
    'admin.users.inviteEmailPlaceholder',
    'admin.users.inviteEmailRequired',
    'admin.users.inviteSend',
    'admin.users.inviteSent',
    'admin.users.inviteCreatedWithoutEmail',
    'admin.users.inviteResend',
    'admin.users.inviteResent',
    'admin.users.inviteLinkTitle',
    'admin.users.inviteLinkOneTime',
    'admin.users.inviteCopyLink',
    'admin.users.inviteCopied',
    'admin.users.inviteCopyFailed',
    'admin.users.inviteTooManyAttempts',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('feature refusal copy ships translated in every locale', () => {
  // A refused toggle (F-t01-015) toasts through these keys with the feature
  // titles named inside the message; an absent key falls back to English
  // inside otherwise translated switchboards.
  const keys = [
    'admin.ai.featureDisabled',
    'admin.setup.features.errors.blocked',
    'admin.setup.features.errors.dependency',
    'admin.setup.features.errors.dependents',
    'admin.features.advancedClose.title',
    'admin.features.advancedSubscriptions.title',
    'admin.features.allocations.title',
    'admin.features.allocationsAtEntry.title',
    'admin.features.allocationsAtPosting.title',
    'admin.features.apiAccess.title',
    'admin.features.mcpAccess.title',
    'admin.features.multiCurrency.title',
    'admin.features.multiSubsidiary.title',
    'admin.features.payroll.title',
    'admin.features.projectScheduling.title',
    'admin.features.propertyManagement.title',
    'admin.features.queryConsole.title',
    'admin.features.scripts.title',
    'admin.features.subcontracts.title',
    'admin.features.wipBilling.title',
  ] as const
  // REST API is kept verbatim in ja/zh product copy and Scripts is the same
  // word in fr/es/pt-BR — genuine conventions, like the documented de/pt-BR
  // 'Status' identical-term exemption.
  const identicalExemptions = new Set([
    'ja:admin.features.apiAccess.title',
    'zh:admin.features.apiAccess.title',
    'fr:admin.features.scripts.title',
    'es:admin.features.scripts.title',
    'pt-BR:admin.features.scripts.title',
  ])
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (!identicalExemptions.has(`${locale}:${key}`)) {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('recent journal widget copy ships translated in every locale', () => {
  // The dashboard recent-entries rows (F-t01-009) rendered the raw "posted"
  // badge and the English "N lines" count; both now resolve through these
  // dashboard.widgets keys.
  const keys = [
    'dashboard.widgets.recentEntryStatusPosted',
    'dashboard.widgets.recentEntryStatusReversed',
    'dashboard.widgets.recentEntryLines',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('money widget copy ships translated in every locale', () => {
  // The MTD revenue/income/margin tiles (dw1) render these dashboard keys;
  // absent outside en they fall back to English inside otherwise translated
  // tiles. Every leaf must exist, keep its ICU placeholders, and differ
  // from English (short financial labels have no true cognates here).
  const keys = [
    'dashboard.widgets.revenue',
    'dashboard.widgets.netIncome',
    'dashboard.widgets.grossMargin',
    'dashboard.catalog.revenue',
    'dashboard.catalog.netIncome',
    'dashboard.catalog.grossMargin',
    'dashboard.metricContext.monthToDate',
    'dashboard.metricContext.noData',
    'dashboard.widgets.expectedReceipts',
    'dashboard.widgets.expectedPayments',
    'dashboard.catalog.expectedReceipts',
    'dashboard.catalog.expectedPayments',
    'dashboard.metricContext.next30Days',
    'dashboard.widgets.topCustomers',
    'dashboard.widgets.topVendors',
    'dashboard.widgets.openCount',
    'dashboard.catalog.topCustomers',
    'dashboard.catalog.topVendors',
    'dashboard.widgets.runway',
    'dashboard.catalog.runway',
    'dashboard.metricContext.weekOf',
    'dashboard.metricContext.noBurn',
    'dashboard.metricContext.cashShortfall',
    'dashboard.metricContext.runwayWeeks',
  ] as const
  // Reviewed identicals: an acronym plus a bare number renders the same in
  // every locale by design (the MRR/Cron precedent) — pinned exact.
  const identicalByFact = new Set([
    'dashboard.metricContext.dso|DSO {days}',
    'dashboard.metricContext.dpo|DPO {days}',
  ])
  const source = flattenCatalog('en')
  for (const key of [...keys, ...[...identicalByFact].map((entry) => entry.split('|')[0]!)]) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
    for (const entry of identicalByFact) {
      const [key, term] = entry.split('|') as [string, string]
      assert.equal(catalog.get(key), term, `${locale}:${key} must stay the reviewed identical term`)
    }
    const drift = [...(keys as readonly string[]), ...[...identicalByFact].map((entry) => entry.split('|')[0]!)].filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} money-widget translations drop or rename ICU placeholders`)
  }
})

test('property creation drawer copy ships translated in every locale', () => {
  // The New-property drawer (F-t09-013 residual) was fully hard-coded
  // English; every string now resolves through these keys plus common
  // labels/actions and the translated workspace CTA title.
  const keys = [
    'entities.propertyManagement.propertyDrawer.description',
    'entities.propertyManagement.propertyDrawer.code',
    'entities.propertyManagement.propertyDrawer.legalEntity',
    'entities.propertyManagement.propertyDrawer.propertyLocation',
    'entities.propertyManagement.propertyDrawer.fixedAsset',
    'entities.propertyManagement.propertyDrawer.rentIncomeAccount',
    'entities.propertyManagement.propertyDrawer.camIncomeAccount',
    'entities.propertyManagement.propertyDrawer.depositLiability',
    'entities.propertyManagement.propertyDrawer.defaultDepositBank',
    'entities.propertyManagement.propertyDrawer.street',
    'entities.propertyManagement.propertyDrawer.city',
    'entities.propertyManagement.propertyDrawer.region',
    'entities.propertyManagement.propertyDrawer.postalCode',
    'entities.propertyManagement.propertyDrawer.selectEntity',
    'entities.propertyManagement.propertyDrawer.notMapped',
    'entities.propertyManagement.propertyDrawer.notOwned',
    'entities.propertyManagement.propertyDrawer.selectAccount',
    'entities.propertyManagement.propertyDrawer.selectLiability',
    'entities.propertyManagement.propertyDrawer.selectBank',
    'entities.propertyManagement.propertyTypes.residential',
    'entities.propertyManagement.propertyTypes.commercial',
    'entities.propertyManagement.propertyTypes.mixedUse',
    'entities.propertyManagement.propertyTypes.industrial',
    'entities.propertyManagement.propertyTypes.other',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('api keys copy ships translated in every locale', () => {
  // The api-keys page (F-t01-018) rendered fully English under lang=es: the
  // whole block was absent there, plus three rate-limit keys everywhere
  // except en, plus fr copying the table scopesCount. fr statusActive reads
  // 'active' in both languages — correct French feminine for "clé",
  // documented like the Status exemption.
  const esKeys = [
    'admin.apiKeys.title',
    'admin.apiKeys.description',
    'admin.apiKeys.searchPlaceholder',
    'admin.apiKeys.empty',
    'admin.apiKeys.table.name',
    'admin.apiKeys.table.key',
    'admin.apiKeys.table.owner',
    'admin.apiKeys.table.scopes',
    'admin.apiKeys.table.scopesCount',
    'admin.apiKeys.table.fullScope',
    'admin.apiKeys.table.lastUsed',
    'admin.apiKeys.table.status',
    'admin.apiKeys.statusActive',
    'admin.apiKeys.statusRevoked',
    'admin.apiKeys.drawer.newKey',
    'admin.apiKeys.drawer.newTitle',
    'admin.apiKeys.drawer.description',
    'admin.apiKeys.drawer.nameRequired',
    'admin.apiKeys.drawer.namePlaceholder',
    'admin.apiKeys.drawer.descriptionPlaceholder',
    'admin.apiKeys.drawer.saveFailed',
    'admin.apiKeys.drawer.created',
    'admin.apiKeys.drawer.updated',
    'admin.apiKeys.drawer.revoke',
    'admin.apiKeys.drawer.revokeConfirm',
    'admin.apiKeys.drawer.revokeFailed',
    'admin.apiKeys.drawer.revoked',
    'admin.apiKeys.drawer.revokedNotice',
    'admin.apiKeys.drawer.keyCreated',
    'admin.apiKeys.drawer.keyCreatedHint',
    'admin.apiKeys.drawer.copy',
    'admin.apiKeys.drawer.copied',
    'admin.apiKeys.drawer.createKey',
    'admin.apiKeys.drawer.saveChanges',
    'admin.apiKeys.drawer.scopesHeading',
    'admin.apiKeys.drawer.scopesHint',
    'admin.apiKeys.drawer.scopesCount',
    'admin.apiKeys.drawer.scopesRequired',
  ] as const
  const rateLimitKeys = [
    'admin.apiKeys.drawer.rateLimitLabel',
    'admin.apiKeys.drawer.rateLimitPlaceholder',
    'admin.apiKeys.drawer.rateLimitHint',
  ] as const
  const source = flattenCatalog('en')
  for (const key of [...esKeys, ...rateLimitKeys]) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const esCatalog = flattenCatalog('es')
  for (const key of [...esKeys, ...rateLimitKeys]) {
    const value = esCatalog.get(key)
    assert.ok(value && value.trim(), `es is missing ${key}`)
    assert.notEqual(value, source.get(key), `es must not copy English ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en' && candidate !== 'es').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of rateLimitKeys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
  const frTableScopesCount = flattenCatalog('fr').get('admin.apiKeys.table.scopesCount')
  assert.ok(frTableScopesCount && frTableScopesCount.includes('autorisation'), 'fr must translate the api-keys scopesCount')
})

test('setup wizard copy ships translated in fr and es', () => {
  // The setup wizard (F-t01-014) rendered fully English under lang=fr+es:
  // the whole setup.wizard block (176 keys) existed only in en. fr
  // payroll.packs.ca.title reads 'Canada' in both languages — the
  // country name is spelled identically, documented like Status.
  const source = flattenCatalog('en')
  const english = new Map([...source].filter(([key]) => key.startsWith('admin.setup.wizard.')))
  assert.ok(english.size > 150, `expected the en wizard block, got ${english.size} keys`)
  const identicalExemptions = new Set(['fr:admin.setup.wizard.payroll.packs.ca.title'])
  for (const locale of ['fr', 'es']) {
    const catalog = flattenCatalog(locale)
    for (const [key, sourceValue] of english) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (!identicalExemptions.has(`${locale}:${key}`)) {
        assert.notEqual(value, sourceValue, `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('go-live guide copy ships translated in fr and es', () => {
  // The readiness go-live guide (F-t01-017) hardcoded its whole body
  // (~55 strings) in the loader, so fr+es rendered English. The loader now
  // resolves every string through admin.setup.guide — this pins the block
  // present and genuinely translated in both locales.
  const source = flattenCatalog('en')
  const english = new Map([...source].filter(([key]) => key.startsWith('admin.setup.guide.')))
  assert.ok(english.size > 40, `expected the en guide block, got ${english.size} keys`)
  for (const locale of ['fr', 'es']) {
    const catalog = flattenCatalog(locale)
    for (const [key, sourceValue] of english) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, sourceValue, `${locale} must not copy English ${key}`)
    }
  }
})

test('setup agents copy ships translated in de, ja, pt-BR and zh', () => {
  // The agents surface (F-t01-014 backfill) had only its nav plus one string
  // outside en/fr/es — the other four locales fell back to English. Genuine
  // loanwords stay identical and are documented: de Pack/Status, pt-BR
  // Status/Manual. ja/zh share no spellings with English at all.
  const source = flattenCatalog('en')
  const english = new Map([...source].filter(([key]) => key.startsWith('admin.setup.agents.')))
  assert.ok(english.size > 140, `expected the en agents block, got ${english.size} keys`)
  const identicalExemptions = new Set([
    'de:admin.setup.agents.overview.columns.pack',
    'de:admin.setup.agents.overview.columns.status',
    'de:admin.setup.agents.activity.packColumn',
    'de:admin.setup.agents.activity.statusColumn',
    'pt-BR:admin.setup.agents.overview.columns.status',
    'pt-BR:admin.setup.agents.activity.triggers.manual',
    'pt-BR:admin.setup.agents.activity.statusColumn',
  ])
  for (const locale of ['de', 'ja', 'pt-BR', 'zh']) {
    const catalog = flattenCatalog(locale)
    for (const [key, sourceValue] of english) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (!identicalExemptions.has(`${locale}:${key}`)) {
        assert.notEqual(value, sourceValue, `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('project billing (applications) copy is present in every locale and translated', () => {
  // The project Billing tabs (F-t03-012) render these keys; a missing key
  // falls back to English on screen.
  const keys = [
    'applications.changeOrders.cancel',
    'applications.changeOrders.formHint',
    'applications.changeOrders.statusLabel',
    'applications.changeOrders.workspaceHint',
    'applications.payApplications.amount',
    'applications.payApplications.application',
    'applications.payApplications.cancel',
    'applications.payApplications.create',
    'applications.payApplications.drawHint',
    'applications.payApplications.invoice',
    'applications.payApplications.newHint',
    'applications.payApplications.openInvoice',
    'applications.payApplications.statusLabel',
    'applications.payApplications.workspaceHint',
    'applications.retainage.cancel',
    'applications.retainage.heldLabel',
    'applications.retainage.periodEnding',
    'applications.retainage.workspaceHint',
    'applications.sov.cancel',
    'applications.sov.formHint',
    'applications.sov.incomeAccount',
    'applications.sov.workspaceHint',
    'applications.workspace.sectionsAria',
  ] as const
  // "Status" is the correct table header in German and Portuguese too —
  // identical to English by linguistic fact, not by paste.
  const identicalByFact = new Set([
    'de:applications.changeOrders.statusLabel',
    'de:applications.payApplications.statusLabel',
    'pt-BR:applications.changeOrders.statusLabel',
    'pt-BR:applications.payApplications.statusLabel',
  ])
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (identicalByFact.has(`${locale}:${key}`)) {
        assert.equal(value, 'Status', `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('retainage receivable control-account copy is present in every locale and translated', () => {
  // The Company control-accounts picker (F-t04-002) renders these keys; a
  // missing key falls back to English on screen and the slot reads unsetup.
  const keys = [
    'admin.settings.controlAccounts.fields.retainageReceivable.label',
    'admin.settings.controlAccounts.fields.retainageReceivable.hint',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('as-of labels ship translated in every locale and keep the date placeholder', () => {
  // Dashboard money tiles and the AR open-receivables tile exclude
  // future-dated documents; the cut-off caption must exist everywhere and
  // keep its {date} placeholder (F-t02-007).
  const keys = [
    'dashboard.metricContext.asOf',
    'ar.cockpit.stats.asOf',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
    assert.ok(english.includes('{date}'), `English source must carry {date} in ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      assert.ok(value.includes('{date}'), `${locale} must keep the {date} placeholder in ${key}`)
    }
  }
})

test('employee directory copy is present in every locale and translated', () => {
  // HR-2b: the native employee list's employment status and service start
  // columns and the no-employment quick-filter option resolve through
  // hrm.directory.*; a missing key renders the raw path in the roster.
  const keys = [
    'hrm.directory.employmentStatus',
    'hrm.directory.serviceStart',
    'hrm.directory.noEmployment',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('banking feed operational panel copy is present in every locale and translated', () => {
  // The /banking/imports live-feeds panel (F-t05-015) renders these keys;
  // present-but-English values read as hardcoded copy on screen.
  const keys = [
    'banking.bankFeeds.operational.title',
    'banking.bankFeeds.operational.manage',
    'banking.bankFeeds.operational.none',
    'banking.bankFeeds.operational.lastSync',
    'banking.bankFeeds.operational.lastAttempt',
    'banking.bankFeeds.operational.never',
  ] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

test('depreciation next-due and equipment activation copy ships localized in every locale', () => {
  // F-t07-005: the zero-post run explanation names its as-of date, next
  // asset/period, amount, and period end. F-t07-006: the refused activation
  // names the missing charge item. Every leaf must exist, be localized, and
  // keep its interpolation placeholders.
  const placeholders: Record<string, string[]> = {
    'assets.run.nextDue': ['{date}', '{asset}', '{period}', '{amount}', '{endsOn}'],
    'assets.equipment.chargeItemRequired': [],
  }
  const source = flattenCatalog('en')
  for (const key of Object.keys(placeholders)) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const [key, parts] of Object.entries(placeholders)) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      for (const part of parts) {
        assert.ok(value.includes(part), `${locale} ${key} must keep placeholder ${part}`)
      }
    }
  }
})

test('feeds empty-state trail uses the sidebar translated labels in fr and es', () => {
  // F-t05-015 residual: the sentence body was translated but its navigation
  // tail stayed 'Company Settings → Bank Feeds' in fr/es. The trail must
  // reuse the sidebar's own labels (setup area + bank-feeds rail entry).
  const trails: Record<string, string> = {
    fr: 'Configuration → Flux bancaires',
    es: 'Configuración → Feeds bancarios',
  }
  for (const [locale, trail] of Object.entries(trails)) {
    const value = flattenCatalog(locale).get('banking.bankFeeds.operational.none')
    assert.ok(value?.includes(trail), `${locale} feeds empty state must point at ${trail}`)
    assert.ok(!value?.includes('Company Settings'), `${locale} feeds empty state must not keep the English trail`)
  }
})

test('cash cockpit and chart copy are present in every locale and translated', () => {
  // The cash cockpit (F-t05-016) reads banking.cash.* with English fallback
  // and labels its charts from analytics.charts.* — both subtrees were
  // absent outside en, so the whole page rendered English.
  const identicalByFact = new Set([
    'de:banking.cash.layout.customize|Layout',
    'pt-BR:banking.cash.layout.customize|Layout',
    'de:analytics.charts.bridge.start|Start',
    'fr:banking.cash.cols.net|Net',
    'fr:analytics.charts.weekly.net|Net',
    'fr:banking.cash.stats.netSub|{amount} net',
    'fr:banking.cash.vitals.cashCycleHint|DSO / DPO',
    'es:banking.cash.vitals.cashCycleHint|DSO / DPO',
    'de:banking.cash.vitals.cashCycleHint|DSO / DPO',
    'ja:banking.cash.vitals.cashCycleHint|DSO / DPO',
    'zh:banking.cash.vitals.cashCycleHint|DSO / DPO',
    'pt-BR:banking.cash.vitals.cashCycleHint|DSO / DPO',
  ])
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter(
    (key) => key.startsWith('banking.cash.') || key.startsWith('analytics.charts.'),
  )
  assert.ok(wanted.length >= 69, `English cash/chart source shrank unexpectedly: ${wanted.length}`)
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('setup sidebar and header copy are present in every locale and translated', () => {
  // The Setup rail (F-t06-024, F-t11-013, F-t01-014) renders these keys;
  // a missing key falls back to English and a pasted-English value reads
  // as untranslated chrome. "CRM" is the correct label in all six locales
  // (initialism, not a paste) and is pinned to that exact term.
  const keys = [
    'admin.setup.title',
    'admin.setup.description',
    'admin.setup.readiness.navTitle',
    'admin.setup.features.runWizard',
    'admin.setup.features.navTitle',
    'admin.setup.bankFeeds.navTitle',
    'admin.setup.paymentProviders.navTitle',
    'admin.setup.invoicing.navTitle',
    'admin.setup.taxSetup.navTitle',
    'admin.setup.fxProvider.title',
    'admin.setup.laborCosting.navTitle',
    'admin.setup.payroll.navTitle',
    'admin.setup.assetDepreciationSetup.navTitle',
    'admin.setup.taxDepreciationSetup.navTitle',
    'admin.setup.agents.nav.overview',
    'admin.setup.agents.nav.library',
    'admin.setup.agents.nav.activity',
    'admin.setup.groups.company',
    'admin.setup.groups.accounting',
    'admin.setup.groups.taxes',
    'admin.setup.groups.dimensions',
    'admin.setup.groups.projects',
    'admin.setup.groups.compliance',
    'admin.setup.groups.billing',
    'admin.setup.groups.revenue',
    'admin.setup.groups.inventory',
    'admin.setup.groups.workforce',
    'admin.setup.groups.assets',
    'admin.setup.groups.currency',
    'admin.setup.groups.agents',
    'admin.setup.entities.company.title',
    'admin.setup.entities.tax-jurisdictions.title',
    'admin.setup.entities.tax-registrations.title',
    'admin.setup.entities.tax-codes.title',
    'admin.setup.entities.tax-rates.title',
    'admin.setup.entities.tax-groups.title',
    'admin.setup.entities.tax-return-forms.title',
    'admin.setup.entities.tax-report-lines.title',
    'admin.setup.entities.tax-regimes.title',
    'admin.setup.entities.tax-pool-classes.title',
    'admin.setup.entities.tax-first-year-rules.title',
    'admin.setup.entities.classes.title',
    'admin.setup.entities.segment-definitions.title',
    'admin.setup.entities.segment-values.title',
    'admin.setup.entities.departments.title',
    'admin.setup.entities.locations.title',
    'admin.setup.entities.payment-terms.title',
    'admin.setup.entities.number-sequences.title',
    'admin.setup.entities.time-types.title',
    'admin.setup.entities.pay-schedules.title',
    'admin.setup.entities.pay-components.title',
    'admin.setup.entities.union-agreements.title',
    'admin.setup.entities.worker-comp-groups.title',
    'admin.setup.entities.asset-categories.title',
    'admin.setup.entities.depreciation-methods.title',
    'admin.setup.entities.depreciation-book-policies.title',
    'admin.setup.entities.currencies.title',
    'admin.setup.entities.sftp.title',
    'admin.setup.entities.payment-operations.title',
    'admin.setup.entities.account-groups.title',
    'admin.setup.entities.subsidiaries.title',
    'admin.setup.entities.intercompany-pairs.title',
    'admin.setup.entities.subsidiary-ownership-interests.title',
    'admin.setup.entities.accounting-books.title',
    'admin.setup.entities.allocations.title',
    'admin.setup.entities.fx-rates.title',
    'admin.setup.entities.consolidated-fx-rates.title',
    'admin.setup.entities.item-rate-books.title',
    'admin.setup.entities.item-rate-book-assignments.title',
    'admin.setup.entities.recognition-rules.title',
    'admin.setup.entities.fair-value-prices.title',
    'admin.setup.entities.stock-locations.title',
    'admin.setup.entities.item-inventory-profiles.title',
    'admin.setup.entities.bom-components.title',
    'admin.setup.entities.overhead-rates.title',
    'admin.setup.entities.overhead-model.title',
    'admin.setup.entities.overhead-model.application.systemRule.title',
    'admin.setup.entities.compliance-classes.title',
    'admin.setup.entities.compliance-requirements.title',
    'admin.setup.entities.information-return-box-rules.title',
    'admin.setup.entities.income-tax-rates.title',
    'admin.setup.entities.payroll-filing-accounts.title',
    'admin.setup.entities.entitlement-plans.title',
    'admin.setup.entities.entitlement-plan-limits.title',
    'admin.setup.entities.entitlement-service-tiers.title',
    'admin.setup.entities.pay-derived-rules.title',
    'admin.setup.entities.trades.title',
    'admin.setup.entities.payroll-holidays.title',
    'admin.setup.entities.extension-settings.title',
    'data.nav.export',
    'data.nav.import',
    'data.nav.history',
    'data.nav.group',
    'crm.setup.title',
    'projectTypes.title',
    'labor-pricing.navTitle',
    'close.setup.title',
  ] as const
  // Reviewed cognates: the correct term in that locale is spelled exactly
  // like English, so the pin requires the paste instead of rejecting it.
  // "CRM"/"SFTP" are initialisms; French Taxes/Dimensions/Agents/Classes/
  // Segments and Portuguese Classes are ordinary nouns with identical
  // spelling; German Import/Export/Compliance are the standard UI terms.
  const COGNATES = new Set([
    'de:admin.setup.entities.sftp.title',
    'de:admin.setup.groups.compliance',
    'de:data.nav.export',
    'de:data.nav.group',
    'de:data.nav.import',
    'fr:admin.setup.entities.classes.title',
    'fr:admin.setup.entities.segment-definitions.title',
    'fr:admin.setup.groups.agents',
    'fr:admin.setup.groups.dimensions',
    'fr:admin.setup.groups.taxes',
    'ja:admin.setup.entities.sftp.title',
    'pt-BR:admin.setup.entities.classes.title',
    'pt-BR:admin.setup.entities.sftp.title',
    'zh:admin.setup.entities.sftp.title',
  ])
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      if (key === 'crm.setup.title') {
        assert.equal(value, 'CRM', `${locale}:crm.setup.title must stay the reviewed initialism`)
      } else if (COGNATES.has(`${locale}:${key}`)) {
        assert.equal(value, source.get(key), `${locale}:${key} must stay the reviewed cognate`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
  }
})

test('Portuguese fixed-asset tax pool uses the reviewed regime label', () => {
  const catalog = flattenCatalog('pt-BR')

  assert.equal(catalog.get('assets.taxPools.regime'), 'Regime fiscal')
})

test('every installable payroll pack slot has a statutory account label', () => {
  // The payroll setup wizard labels each statutory slot's account picker
  // with `packAccounts.<country>.slots.<key>` and falls back to the raw
  // slot key when the message is missing — the US pack shipped its
  // state/local income tax slots with no labels, so the wizard showed
  // `state_income_tax` / `local_income_tax` in every locale. Non-English
  // locales deep-merge over English at request time (web/i18n/request.ts),
  // so English coverage IS every-locale coverage for these labels.
  const source = flattenCatalog('en')
  const missing: string[] = []
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    if (!pack.installable) continue
    for (const slot of pack.statutorySlots) {
      const key = `payroll.settingsPage.packAccounts.${pack.country}.slots.${slot.key}`
      const value = source.get(key)
      if (!value || !value.trim() || value === slot.key) missing.push(key)
    }
  }
  assert.deepEqual(missing, [], `these statutory slots render as raw keys:\n${missing.join('\n')}`)
})

// 149 keys
const PAYROLL_CHROME_PREFIXES = [
  'payroll.title',
  'payroll.description',
  'payroll.empty.',
  'payroll.tabs.',
  'payroll.home.',
  'payroll.list.',
  'payroll.columns.',
  'payroll.status.',
  'payroll.checklist.',
  'payroll.run.',
  'payroll.remittances.',
  'payroll.yearEnd.',
  'payroll.register.',
  'payroll.newRun.',
  'payroll.runType.',
  'payroll.wizard.steps.',
  'payroll.wizard.finish.',
  'payroll.wizard.funding.',
  'payroll.wizard.bankFile.',
]
const PAYROLL_CHROME_SOURCE_HASHES: Record<string, string> = {
  'payroll.checklist.incomplete': 'a26f9a130a9d9f7445eaeb613c98b8ff6bfcc0777aa2e4cf5375ae5b4e3befe8',
  'payroll.checklist.openSettings': '82d325df366b1ac086c7f8625c21b1e38186104cec430afca2dfc47ef6d2de91',
  'payroll.columns.employees': 'c98270317b51cbb34dd7db32e32d98e25c243111762b17902aa37b7ecea659fe',
  'payroll.columns.gross': '0589b626717ccca8914a41a144ce292bf279c52ac7135af131cece4e747e89aa',
  'payroll.columns.net': '660fb2c41d028988b2093656a80d3ae99bc67cd0d5acca5c6063793819b15881',
  'payroll.columns.number': 'bd82cf16699be29ec05cbb763199c12f0dced428dde8381dbdd31c1d5dd0e8d4',
  'payroll.columns.payDate': 'bd06c4ebc2eab6557364ebf541e0418d8a2630153db8a01e96dbe681ec7a9355',
  'payroll.columns.period': '6e795d4d3cc21c5ca8349ab5e917482197aa612d1a218f9e9411467db73242bb',
  'payroll.columns.schedule': 'f4830a1dae2980447c716bd4b5779b7013575ef09f70ef4731457218792487b3',
  'payroll.columns.status': '920e413c7d411b61ef3e8c63b1cb6ad058d5f95f8b481dbafe60248387d8c355',
  'payroll.description': 'e2701573f05d37c1008ca59e4557c2baaf000ff0d67bbc02622ab4db22269e9e',
  'payroll.empty.profiles': '25c11d1a1d1907e64938f76bb2a951d1504f51976eeeaf739059e8fa7c243239',
  'payroll.empty.runs': '963392599651b0b972efbefaedf0c1eb60858b49ef94a7e14d9693030d6647a2',
  'payroll.home.actions.remittances': '8fc2a9656b5308428b116ac457b66a34793219d201920a0a14179c07dc4877fc',
  'payroll.home.actions.resume': '020d618666ac1606183e3f70991a75f7ee85a53be238fd58532f076a5fdfb4ee',
  'payroll.home.actions.reviewPost': 'cef1b025f6c1d0a70ac38840a6c299ef035f7b7cccbab3155c9777cec46aeff7',
  'payroll.home.actions.startRun': '4a1d2b0bf63f0601999e11727cf9bc04745e0867cd9492883030cb2557888aec',
  'payroll.home.actions.viewRuns': '5892ac63aab0c1d77c2110f4a1dfee29589c407a6b6dfed4b95025bbc050b8e7',
  'payroll.home.actions.yearEnd': '9a63187ca66879c3edcaff1fd1159b7cde9fd6b66cd53ca0fbb3e7392ec8dd1f',
  'payroll.home.current.noSchedules': 'd999afc22bef7e2038322362fba343287e278bc1851ecb162151b6c5fb0780b4',
  'payroll.home.current.title': 'b0bdea00c98eaa4a75c9600936f7ec5f9d43e16eeb1617930fb042ac3088deaa',
  'payroll.home.directory.employees': 'c98270317b51cbb34dd7db32e32d98e25c243111762b17902aa37b7ecea659fe',
  'payroll.home.directory.employeesHint': '0e2c3fb537248bdf9059979d0fa143ab4ce650bbe24c62d42df7ee2c747b4f3d',
  'payroll.home.directory.openingBalances': '28761a2a0372e004d4fdf2e968b19c70caca5871ae7829490483530646e64867',
  'payroll.home.directory.parallelRun': '7b3ce4aa41193f215dbf9c7b3f8254ec9f3876828ec62807e970c0e2805f635e',
  'payroll.home.directory.retro': '8ded50224886e49edb45d9ddebb82b2944183b522dc9405cebc94b805dac7154',
  'payroll.home.directory.runs': '5892ac63aab0c1d77c2110f4a1dfee29589c407a6b6dfed4b95025bbc050b8e7',
  'payroll.home.directory.runsHint': '6a7f5a5210347fb72fe6326417836338b0b280a089dbb79cad8cb3a015881efc',
  'payroll.home.directory.setup': '15d68318003ecef218a282bd6f854dcaa5f3b0552e1b54987d764fe2c409924a',
  'payroll.home.directory.setupHint': '55d9c974bbd96d56069d6e581fd00e94a101025d2a54e31f34d012fa54e7dd7b',
  'payroll.home.directory.title': '15ed6d30cf4842a34e45eb18d9e93988cecbcc18262b7ed8dcf96e95de1cfc7a',
  'payroll.home.exceptions.allClear': '605004d7175dda3d635450873436da51ecb5553a224b05e45e7ed452bbad0746',
  'payroll.home.exceptions.missingProfile': '644f0043302e75935f19d32716b01b7a243ae2cf6ea26250d8a363c899a72e9a',
  'payroll.home.exceptions.missingWage': '9a8639687905376b314778ae41babb6fab1d33bc47026db2193c9a157271ff48',
  'payroll.home.exceptions.moreMissingProfiles': 'c71f43d7723f6281337939c5382639055e88654a9acf9db15ca4bf71562d13b4',
  'payroll.home.exceptions.moreMissingWages': 'caa71439cc9b76ed7750149f3ed3b3c206022d936c5b7ba8dcabd40daa514860',
  'payroll.home.exceptions.title': 'c1ebc7817870e5be78fceae559ba5fcac2b68d5c5498d8080298004f3f79d62d',
  'payroll.home.frequency.biweekly': 'c95729ce66367d05386d90719dbd471cc4150df948d4fb1cd556f7985655da29',
  'payroll.home.frequency.monthly': '9b11f6b707d2a03e0265465f32520bc1bc213de121de958539662d0ec1453fcb',
  'payroll.home.frequency.semi_monthly': 'ceaa97df8beb1af938051d6df7a039cd81666ac92bccba577ea04f374ef5553c',
  'payroll.home.frequency.weekly': '2975132481a7a6957cfa95055d04e706f21f1a613f448d0a17463f2eacca4636',
  'payroll.home.previous.none': '1560d733989509e5139a31612a797c7ce9e21eb10fb40fad9e3569920faccc54',
  'payroll.home.previous.title': '956853b817e5fab32938cabb1dfdc574b811cfaaa32e1723d5e35aa7e978d9e4',
  'payroll.home.tabs.overview': '53fe8dfb6d9e1b03219adddcc3ffb741557dd579dc653d026097c463def4a8fe',
  'payroll.home.tabs.remittances': '8fc2a9656b5308428b116ac457b66a34793219d201920a0a14179c07dc4877fc',
  'payroll.home.tabs.runs': '5892ac63aab0c1d77c2110f4a1dfee29589c407a6b6dfed4b95025bbc050b8e7',
  'payroll.home.tabs.separations': 'd80cf8b228846a2906d0ba7b447e13ea28b7ecb8893dd8c0ee39390700097a4d',
  'payroll.home.tabs.yearEnd': '9a63187ca66879c3edcaff1fd1159b7cde9fd6b66cd53ca0fbb3e7392ec8dd1f',
  'payroll.home.vitals.employees': '22974def8fac27a522ec79dd2977020e6bc38b754f992415d67cfc873a7d1a92',
  'payroll.home.vitals.employeesSub': '0e2c3fb537248bdf9059979d0fa143ab4ce650bbe24c62d42df7ee2c747b4f3d',
  'payroll.home.vitals.nextPayDate': 'e80efe0c31b06f425fd6a9d1edb5e7fad4e30397e7d786f8078a1c3f5ab42f42',
  'payroll.home.vitals.noSchedule': '90a245e783edfb30669a50ad537085514cc92e681d32eea0a6c6ff305c7b2c2c',
  'payroll.home.vitals.periodsOf': '6b0d9cd3d552732332cb1d9e25aaaa31e1e2cfbd87af618bb8a287c8badf4cb5',
  'payroll.home.vitals.periodsRan': 'cfb980e45387229fcd7ceadae33ac7e309c3b94a96d2036b35e81fae97f9ecc7',
  'payroll.home.vitals.periodsRanSub': '6f73e5441ca8e2b61fac5fbe38221ca918d2b4ab7e28b3f0b98b9b1f0e5fcc50',
  'payroll.home.vitals.ytdEmployerCost': 'd5300731fb4034101bdcc9c4ec5f1633316e06d84f7d2eaf19ad82a74282f09c',
  'payroll.home.vitals.ytdGross': '0dae0182fadb48e12a2b024eb1afa09456f0847798d241378b41d21ed9f1bf19',
  'payroll.home.vitals.ytdNet': '79a260534ad6993aa9a5b14e07e6437b02ced7c2f2aa0d7c0e02742789a3de68',
  'payroll.home.vitals.ytdNetSub': '145472234104cf4548d73688d931d826b082d46134de90a8d1ac092b0ebadceb',
  'payroll.list.description': '89945291cbc257cfc325c622d6d422c6aa7979cdd0e769465cb400e64d563c81',
  'payroll.list.open': '95fe7393c85ec788369d165a30dce046b1a8463ec83924e1a0af0f0fde8c1329',
  'payroll.list.stageFilter': 'de838855e4a6e04ea2f284b246a07a1126e7fcd151be9449e112006ad7db5c50',
  'payroll.list.title': '5892ac63aab0c1d77c2110f4a1dfee29589c407a6b6dfed4b95025bbc050b8e7',
  'payroll.newRun.create': 'b6207e8df96a1465ddf6b22060a1160bba3510c6a6a27e0dd78e2f64be910000',
  'payroll.newRun.description': '27b8e56762842029a51dea3bf9959adcdb1b076d47fc891a511b369a99ee787b',
  'payroll.newRun.employees': 'ea72d7040845c167f23ebe0a4831483a7480a8953399d59ed303b69962c7cf48',
  'payroll.newRun.employeesHint': '6d92d0cab408789334ef0719afb0b4791f0b197addd4e6254b445de533e5bdf2',
  'payroll.newRun.invalidWindow': '0f808b5e1c28c2fc82764debc55a28e13df66f0250b78f3a3235c81a4ff6850f',
  'payroll.newRun.noSchedules': '55c4c40c8c6c194516c1df77706f108e08704539654b8ad45ddfcc12c0f132ff',
  'payroll.newRun.noTerminated': '22779dfc298e35045cb282e3c6dd1092836ddb532bf7851a032fc01ba306e146',
  'payroll.newRun.notBegun': '136cba81b60a5e15f9b7000830a1f50dd100fc016c3754a9b61090b615e1eb58',
  'payroll.newRun.payDateHint': '2eaa706e1da4a91e8cacbb90f35efa2263f37f15dd6112885591be656068dbc8',
  'payroll.newRun.periodEnd': 'eeae9fdd63e0d5124bbce9ad39d4ce87e7576590cc79101610aa0e7a76e9be4e',
  'payroll.newRun.periodStart': '32d302d524826d2b53741ee5386f5d52af7d664105953d2150c870c4927f5bad',
  'payroll.newRun.runType': 'fb5d9febad2048ddadbeeb27731d5ef438d688ab4a1aa85fec227a15be7ed287',
  'payroll.newRun.runTypeHint.bonus': 'fa5a9837f86704f553afdf82fc86ee40f9df071968512ac8dbbc6cbdd2d8fd8d',
  'payroll.newRun.runTypeHint.regular': '25a2c4bfa7932d25dcdbade46fcbf3a2c1b1cf30cdea0c2fd16f55c78b3b77d6',
  'payroll.newRun.runTypeHint.termination': 'f7ade71f4bc71107209baf4ec91c8e4ef9619462456db434c8e40a0482a2b85e',
  'payroll.newRun.schedule': '56dfc97137f34180cb3651449135e39dc59ded527932ef55050a9609166751e7',
  'payroll.register.cppFica': '73d16a069a8b67ecbf1b3ff53bdfc2b59388b6d13237b592331a7206af2e214c',
  'payroll.register.otherDeductions': 'd5a0c1a14ee04bfd85d19edf78aa69dd8311a765133e5607302119b5668861b6',
  'payroll.register.print': 'df0fe79898ef413ea686b3c25368cff678815b14862c796aa366ca40bdb547c7',
  'payroll.register.title': '956ba70ca6be0bb877fc91c4645dd134c7160a580ceba4cdcc97c78eebda8f20',
  'payroll.register.totals': 'f3ef725dc1a41439b9f10a3cfdfa0f480290d7f03aa812aa8b8cee57b7a42008',
  'payroll.remittances.apLink': '5319b16e429ce3ca4645678640677581596f1def13ac0f4ed1e85a23a78cd00f',
  'payroll.remittances.apNote': '7ce8092119c69f85dd15cd27187459b83d574b6adbe6c396e8f540470cc19dbe',
  'payroll.remittances.apply': '31e392d1c0378beca611de66c0f4c71cba29159905cc54242d9bddee5b23d851',
  'payroll.remittances.assignVendor': '91a3c9e42074aa1c0cd479c8c4a838c8c42cbae2f9998fa6ef73c1877ba1733a',
  'payroll.remittances.attributeEntity': 'c71ce133712eb2a0429f6ee570088f531fd018c35743d92e49201eaf2ffa4f51',
  'payroll.remittances.back': '53fe8dfb6d9e1b03219adddcc3ffb741557dd579dc653d026097c463def4a8fe',
  'payroll.remittances.billCreated': 'a24f44ba16e4dad72ce8de5896b08b3081ebf4944e9e35624a94625ec025b308',
  'payroll.remittances.context': '53d078a30ff0f9dc84813cb8b71f4ff5e946db2202e33da13acfd84cd6b9e624',
  'payroll.remittances.createAnother': '66b14727e315e6dcaecf788be813ac5fb360dfc023020db450a0c38502b37b47',
  'payroll.remittances.createBill': 'd05c700fd23b3a41fe089bbff08b55db8f1b0eb8002f2742b6b4b174eb92b582',
  'payroll.remittances.description': '73573f2c47fdc4bf6908e01acd69f21d99022887011f178b37085214ed857765',
  'payroll.remittances.dueOn': 'b607af8330b6721ee5e9106b16ec8511efc982b3f393c4a2fabd33239a2d1073',
  'payroll.remittances.employer': '54a3b64c67ddb4343c34c4449d625f60823bf937be3b5823f3b11d9c9c0a20bd',
  'payroll.remittances.empty': '8e0cf1cd87263e110ae307de3237788ab34186d6b17ef1a26e5da27c77b086e8',
  'payroll.remittances.from': '218197693424e0154cefc0af31aed96c084b987e08136e91d5528ddbb5461e24',
  'payroll.remittances.noAccount': '125122de33c22326c4f3029adc0027e4c5c61281342734327e66eeb9933a7d0c',
  'payroll.remittances.title': '6e1e7136fa5ecd4a7efb546fd666072aedf1492176f70abfa26f40dac6a4e696',
  'payroll.remittances.to': 'f4b06ef6d3c81436f60a318c81c42f8f7e2d774d45a22f3b9b5f3b6980d28146',
  'payroll.remittances.total': '362263a1b1ef93ae2cdecb333037e374cb4a49e077081f555a28af2dc76a1b63',
  'payroll.remittances.translated': '7cdb72c1d434d263f2f0ee043dcf2d379dcfbf940c55658bb3903c7fb0ffd855',
  'payroll.remittances.unassigned': '76d349b2a55266a51b7234236fb74db846e734121b6726058da7fc39a0581b1a',
  'payroll.remittances.withheld': '7f5ad98195ddf9d5da5f3bc2a67f39ed865f94200ecae8c874fac12159ca84d5',
  'payroll.run.approvalNotRequired': '915b6ed78c68b893990815aab4cf5034015617e286e5da2dc018a6f2f9fc8f5e',
  'payroll.run.approvalPending': '209a22c19e77ab07406c80dab264f42ada4775cc507171cc8bb3e0d783a6a83c',
  'payroll.run.approvalSubmitted': 'a0e42da94f35822594798d592ff9c2340469227370f9d8ec1b9af7f1a76e6f6f',
  'payroll.run.calculate': '2121cc15afb6ba5350deb90e1a292faa7d932537a19ddddadff4aeb796a8d595',
  'payroll.run.calculateDone': 'ab4d17df1be5e14501d827733d62e0c092b6122f48f95892cb125628339db90c',
  'payroll.run.calculateRefusedAll': '7ee2d76d302fcd93f386d5d8310521b8582cfa6e7976340c1d4df8f88ad18c8c',
  'payroll.run.commit': '82a9c46ffa4789945d9f2359d75891558ef6faa8dee09e4b25e4e0597704f5bd',
  'payroll.run.commitDone': 'c658f4ed443d30ae20af749910d66fa1791cab0edd50e4eabd63e71667a2cc31',
  'payroll.run.discardBody': '46819196134b1b7432643ca63d242ff13469f69a49230a507a90f0124b3240bf',
  'payroll.run.discardDone': '4e89be9429f925b46539563074130a8b9c61509b311fb2c78fd2c5e95e9f3296',
  'payroll.run.discardDraft': 'cb30147eec19a75829e93b86d1cc01a88fa43a68ecce2bbd2aef06dcfe7b70ea',
  'payroll.run.discardTitle': 'b0991148c0e46622f6956d5b85d4d96f10db2323eadb14bde23004c67489a0d8',
  'payroll.run.employerCost': 'a9a907e63324e4e63486704af9ec6da5620d92ab53bd1200749d40c329558b9e',
  'payroll.run.empty': 'c8eb26bf0e9fd229af9c93f881f1a5cf1e769399b34133b12141dd997d1151ba',
  'payroll.run.lineKind.deduction': '269c3f89d7f948718293656d2f2040409319ff11e650c98c87edcb25f28997c7',
  'payroll.run.lineKind.earning': 'db16b9c47de42f782af890bacab6725fafac4edb8fcad3d860a3cab2cd0bb60c',
  'payroll.run.lineKind.employer_contribution': '54a3b64c67ddb4343c34c4449d625f60823bf937be3b5823f3b11d9c9c0a20bd',
  'payroll.run.post': 'a5554622c655c7a7e470c115f374d92595fa3b1f431dc6ee3d1edfbc103846ed',
  'payroll.run.postDone': 'ee33e307f5d5b859b18522bbd1f0024169bf1ebdc3f183a5b0cacdc1ce552765',
  'payroll.run.printSet': '0b2a3e3bff491302b24b5eb0cf53fd1dde266f58c25190865de0a0f16b36c36c',
  'payroll.run.stub.employee': '14014e6a570327892015d91391f0756bc8c84d3594c867af4cefb5a7e9fb4eac',
  'payroll.run.stub.lines': '8f7dbf2cd074d911eb32a65d2cc68181d39d7b05955d384391d3aa7762f233c6',
  'payroll.run.stub.tax': '47e2886ee5d3fcab799efae44644488b428a7cb7d3bf24752b46e93d5c3eb6b8',
  'payroll.run.stub.trace': '8fadfcad7d265020ebc78ffd42d1a6bb7335507b8e08b055bd18bf5c4209f3cb',
  'payroll.run.stubsPrintOnly': '0af9a759f2bc196a106f2bd7359605856f9ed92506f28e2e82becd62cf1ea052',
  'payroll.run.submitApproval': 'beec6c108c0009ae6939ce599427435c276e48423ed24289a3548de56c875397',
  'payroll.run.title': '2f419d72b16c47c35f01fc7d9d33ac338fc25469eee3374946cb135c125ab8b5',
  'payroll.runType.bonus': '7c546f729ddc50709bea66cca61ec89944fcc46f257a2c07f07c3bf3d5efb7b9',
  'payroll.runType.regular': 'b455784ab53072773e72df494aa4b12ac467976447e250c694c11b6f1268e235',
  'payroll.runType.termination': '585819a32a8f71c29e79827a89eef3aaf6fc70b7b832b5e61a1fd3f0e3680d72',
  'payroll.status.calculated': 'c8b3c4b0e288f4d853337be83585bda9c7fb35b983120f59f6c5fe6833f9cac8',
  'payroll.status.committed': 'dd9061853d8b1498557341a82186e1d9087de502101d830b5d1bc2d560399eb0',
  'payroll.status.draft': 'ebf12ef47cf575b3ba9a3cc019c5310146fdac88f6d1be6618d6e91158c2f174',
  'payroll.status.posted': 'afd80c5a1b84c378544290379f7195d17d994e3a6e30675372c6dc58446e0614',
  'payroll.status.void': '4e7ba40328eee49c03ebf12bed83a10f42022b10601b9963ee299e50cbde0026',
  'payroll.tabs.employees': 'cb380f519abdd1fe18d31c4e75497c251d8ef92f889b766dd3623d3b30c853e7',
  'payroll.tabs.runs': '5892ac63aab0c1d77c2110f4a1dfee29589c407a6b6dfed4b95025bbc050b8e7',
  'payroll.title': '53fe8dfb6d9e1b03219adddcc3ffb741557dd579dc653d026097c463def4a8fe',
  'payroll.wizard.finish.amount': '49e96d7cdf58069cc793555324e2226642f2f7f8bfff4cebe0c11a61eecef60a',
  'payroll.wizard.finish.bankAccount': '1b4271352e4485ef6d0069087a0ae8a54e1b44bec22842f7fc6099dfdf677257',
  'payroll.wizard.finish.emailStubs': '02844d5b3414d36ef7ef68ff215c26a7ce07f8d72ea50aee6faf5d6d58216938',
  'payroll.wizard.finish.netPay': '393e8a24f9d51fec40d56c0cb6d39ff847e20927df2961e7cef48d2b14f928a6',
  'payroll.wizard.finish.nextPay': '09f40b28ecc014524beb70575a581bfc4362fb2ec986c713e84d77d5079176a1',
  'payroll.wizard.finish.nextRemit': '93c73642ab30ac3a4cdded16882ba431ce3a62748457fc2a899c788ed6cc8e82',
  'payroll.wizard.finish.nextTitle': 'eaf380e7f60489b7d687971d73fa8687ed68ef0aa7cc9a38310c146b06538067',
  'payroll.wizard.finish.notCommitted': '0307e4d4766e10c40406eb6c00cf7b7c836740ee86a6ca1c2a81f528e61f846c',
  'payroll.wizard.finish.paid': 'fb81b961af456e5e748db7e1b1bff9a5e621b62718234c1937738d1adc317a17',
  'payroll.wizard.finish.partialRecorded': 'bbf18df953db9075fad4dbbee37d492aea918478c64a862f3471ec1406e24e0d',
  'payroll.wizard.finish.partialRecovery': 'f89064121028c1437b7d78fd57a50a9010cf33d34732487418625ad0ddc9dfc5',
  'payroll.wizard.finish.partialTitle': '9e59a82118315e8644491110282bfa36b8be9bfd25e2f6dce0bffaae4147e319',
  'payroll.wizard.finish.paymentRecorded': '3299b321d69b6f4de419d5822b6d8555d19c43ddc69c2ee308ed3e89630aa59c',
  'payroll.wizard.finish.postHint': '89f097de992b8dc0faafa67a1cc59b06f8f65f1f624055c828cdd80d45a571a8',
  'payroll.wizard.finish.postTitle': '68a637fd4332d4e96805dbfac918dff67993f7129c2c1dc5e6f7c7532f4574be',
  'payroll.wizard.finish.postedHint': 'df182961f8870217f0904dace2379c862e9c6c6c80f96e054b646cc5a2bd65b5',
  'payroll.wizard.finish.postedTitle': '76562410688fc1bc8e586b4f84ff4004a2bfff52e4494dbd88e685e406f3f45a',
  'payroll.wizard.finish.printCheques': '70935c7ebb7b9b93ca32ba83f432781f53c65cb0d79bb9f1157ae96a11f05e7a',
  'payroll.wizard.finish.printStubs': 'b3c15b54e5912e0213413ea2e3352a17cb9ec549a42fde952d7cbda674f7ba92',
  'payroll.wizard.finish.recordPayment': '1ef3fba4680a9698be61a7d72b36699e33507b12a251b3194f6419b4494a624d',
  'payroll.wizard.finish.register': '956ba70ca6be0bb877fc91c4645dd134c7160a580ceba4cdcc97c78eebda8f20',
  'payroll.wizard.finish.remittanceHint': '5c289eba8a1733d7c23141d5386f53d97a1292248cd8bc9c4183c952c6c606e7',
  'payroll.wizard.finish.remittanceTitle': '54233e310890d415390079464db2a423929a80ac5dc9f5fd618ca852b362a627',
  'payroll.wizard.finish.stubsEmailed': '5b2a5bfd6f75f006f75ea60ed1383039305bb39d2500ff3cc2c1341da1eaf119',
  'payroll.wizard.finish.stubsEmailedPartial': '2f410529f888c9fe8118aec68e4d9beea335c4bc7e046200f75d674287d48722',
  'payroll.wizard.finish.viewJournal': '7ff4eb73bf39c8207d4079b1b87005f9050d9939724a5c6c2e06c21538affae7',
  'payroll.wizard.funding.title': 'e93df741ad323efdfca3f9a08236d6aa90476b2f3ca01c9b67f062209d4fa660',
  'payroll.wizard.funding.netPay': 'da60b5fc91d89cc3c2bbdd2ea8adf912781d19e6e3969d00c9c55d4e107cb36b',
  'payroll.wizard.funding.liabilities': '636f78c0714e493d8a8f2a7fc5b598b2461f76318e5a3e9c03a34a32a31c5274',
  'payroll.wizard.funding.totalCost': '066aedbf07eec473efa7756465ce026d99fdbfc46ad51ebf67fc81e1676e304f',
  'payroll.wizard.funding.accounts': '65e0d0595002737069516d02961539a2d51ac2718679c4d6699fca0632311c83',
  'payroll.wizard.funding.leadTime': '659176799708b5eb36130e1ad7c2c0ed6bb75e5f215518b8abf5de5070bf573d',
  'payroll.wizard.funding.payDatePast': 'f34e19c60d68104d4b8c7e9a977e22ef581aab1f246855c60e940cfadfd64878',
  'payroll.wizard.funding.short': 'e436c5d797c8e65d27710ad8affd5ad9d6eeff705464ba38e2cf84f68a3902fb',
  'payroll.wizard.funding.rail.eft': '12047ef3ed991997a5eb05dde15e1d5a6e44b929c5da9081b951062b4ed98d7a',
  'payroll.wizard.funding.rail.cheque': '9ba2b092901e9f54e7d95b84c0025d5f1650a3ce61be808b08b6812701bd6f37',
  'payroll.wizard.bankFile.amount': '800d9e23c4f33b8bb918080404d690b1aa13ec03ad5a37033e183cc35db034a0',
  'payroll.wizard.bankFile.auditTitle': '6b0302db0bf7a3504501e2102280334869203895e4f74d5a31ef90eb31467eea',
  'payroll.wizard.bankFile.controlTotal': '800d9e23c4f33b8bb918080404d690b1aa13ec03ad5a37033e183cc35db034a0',
  'payroll.wizard.bankFile.copyHash': '468b6f705402778ba6967fc0dbfe3ca84c22c04b5b389b50061e3b6cb2fe8d5b',
  'payroll.wizard.bankFile.credits': '6cc23fb416a9b9c5ce01a670e661e4220b9a25d5e044fa62cc323806d1ac8415',
  'payroll.wizard.bankFile.download': 'd6eafe82359100423c93c5ce53c352c1b51ca1e699215fcec3f5c5dd9bf12d24',
  'payroll.wizard.bankFile.employees': 'f085ed5a3e46783aae7d2240bb08d4ca68fb4a7c19a243991a96b0c4a4ffb0cb',
  'payroll.wizard.bankFile.event.generate': '827ec8d9f99d052149cd4fce69d14f57563bd5c972074172777670c36907a5a7',
  'payroll.wizard.bankFile.event.release': 'f0b0738f75b8bcd1dd40e42c6233d6d6f4f584bdcfa124741bceeb2c6c5b3249',
  'payroll.wizard.bankFile.event.supersede': 'e5830d265452f1ed47a8fb8891fdc488ab355a71ff18cebee2fe3dd1df2f295b',
  'payroll.wizard.bankFile.excludedTitle': 'd54ac4c83629d1ffbcd9db5adadcc6ce17e780472bb51f431df40560ae9fafa9',
  'payroll.wizard.bankFile.exclusion.default': '011f8699600b988d8c2f34af05320e02af12e5a74a4df7349938e8493e62d3e3',
  'payroll.wizard.bankFile.exclusion.eftFallback': '396efa0a6dfc4c0376275c8de70267ff43de6b38102f7dc32448dbe3b66bb7f4',
  'payroll.wizard.bankFile.exclusion.party': '62cb1af26a3c3c5185c88ff0a6c31322db558d452b765b5ef66c8a0667ad1b9a',
  'payroll.wizard.bankFile.exclusion.profile': '49932c01e5ac633ebe3bfbeda5ae7362fbe11ac8a545f239de75a8533ec9d5e9',
  'payroll.wizard.bankFile.file': '50009ce1da4d15e1c4a04024df691eed5f0d598e2c4c67092f205366d0adf99e',
  'payroll.wizard.bankFile.generate': 'ff4e27882cd732d3b1050872d9e519acfc836903cc0c2afc23c13b18ec7dd058',
  'payroll.wizard.bankFile.generated': 'd3d783f51fdfba3aa69f9ff6ecb6792ba344a8defa127da9989dc085a2170215',
  'payroll.wizard.bankFile.hashCopied': '52e9dc75d30f77e568b05cb0ef2d0469291f8fb3ed9e32bead5f986088e1595b',
  'payroll.wizard.bankFile.hint': '555bd7cc72178816f7069b92baa4ebc9a4859853d179a79d3ba788b51a0408c6',
  'payroll.wizard.bankFile.multipleLive': 'ecfb304235bd767b375d61a03564e39b4ca6c07c6b0fd91c077245fe30411835',
  'payroll.wizard.bankFile.neverReleased': '29aa12aaaacff2bda4de7ee02d313d5a658565e42a37eb75dd1c54adf20bd464',
  'payroll.wizard.bankFile.noProfile': 'a079036af1a35c4ccf07407125ef08c215f889669484e9948b440eb8286f4341',
  'payroll.wizard.bankFile.notConfigured': '9f33f06843e745c0bda6361e9d081672d7f4280f9ad0e8cf967e083f8ac34427',
  'payroll.wizard.bankFile.onFile': '8262d598f62d852f026dd9ba55b360609338fee41a5850d9dff7d97ded2cfe6f',
  'payroll.wizard.bankFile.onPaper': '47ce02c9bf90142d53c9819416b0b70d69a892d092ecbb45c3f8b1d39adae640',
  'payroll.wizard.bankFile.profile': '4567c8a6f9f4aada02126609e87396787b20d751c525b9e53e6f25ba9037fd36',
  'payroll.wizard.bankFile.regenerate': 'bb6c87b1948e62368b727de25cb8103cb7f27cd9c41003c6b419d5968e947c28',
  'payroll.wizard.bankFile.regenerateConfirm': 'bb6c87b1948e62368b727de25cb8103cb7f27cd9c41003c6b419d5968e947c28',
  'payroll.wizard.bankFile.regenerateLabel': 'f80ed17a893116c0317665b00c6d2e99a5c17175bde5ebfe66a055b9cf71315b',
  'payroll.wizard.bankFile.regeneratePlaceholder': 'c6b873e8436aff76ca2bbbd25b3ef4b99675ae5c40f7553437c26d718bb71932',
  'payroll.wizard.bankFile.regenerateTitle': 'e84e18c18bf082daebb41d59e8d50bfa369d9992e3cfb72481bdafb992fe604e',
  'payroll.wizard.bankFile.released': 'f33deea9b1009db3148f2614e5da59c03c6fe43df55972f3860d8b871e1b2ace',
  'payroll.wizard.bankFile.state.generated': '827ec8d9f99d052149cd4fce69d14f57563bd5c972074172777670c36907a5a7',
  'payroll.wizard.bankFile.state.released': '97b1b7760cc02321741c4d37fa9240ffa056188ed8717c43d3133af0464f9b1a',
  'payroll.wizard.bankFile.state.superseded': 'e5830d265452f1ed47a8fb8891fdc488ab355a71ff18cebee2fe3dd1df2f295b',
  'payroll.wizard.bankFile.status': '920e413c7d411b61ef3e8c63b1cb6ad058d5f95f8b481dbafe60248387d8c355',
  'payroll.wizard.bankFile.title': 'fcb572fdd9016762ba29d864308fb42e5daee121861f1f88bd1bba21b0d1c0a2',
  'payroll.wizard.finish.viewPayment': 'f829438b329075582d78a5a4b31511d5cfe7fe7a208d43b731d8113d097652a6',
  'payroll.wizard.steps.finish': '98452ce4ea5d1d3a1e0a8106c62814e8c7aa0e357e3f4d76cc24a7048d8b6811',
  'payroll.wizard.steps.gl': '3a57c2d7783758c2061576c47b4b83ec7c63c73448c1ae777859065615e3c1e0',
  'payroll.wizard.steps.period': 'b073f6c68ef8721107fd9815b19b2c35ec111d526b75c2123d1111ba64424000',
  'payroll.wizard.steps.readiness': 'd53d98c1774966ba468529b735a17d59131becf86e929e1f143bc7f057a73a03',
  'payroll.wizard.steps.review': '7f2085b8c3a9e4613108d42b68b14bc09917aac01829a6f3c96f6707c5586cc9',
  'payroll.yearEnd.cadence.annual': 'c0780ee74289557c17edf45f61c5ea8e6aafc5dc16b8e3e6741ed2a0ebc50ba7',
  'payroll.yearEnd.cadence.annualHelp': '2d626ad8c7b9d6c7f331f70c4f53f264baeff5b243be928168ec61f2693e11e9',
  'payroll.yearEnd.cadence.quarterly': 'c093a9a1b7baac3c0c20b5c58b112b627baff87bba6f8041d3d31c6fa259460e',
  'payroll.yearEnd.cadence.quarterlyHelp': '0459f5bc12f90790c77728f538c41792b56c210959179307a178330b03b1e8aa',
  'payroll.yearEnd.description': '60f1b1bf1f3cc0f6f929d33036cea564c31342265f1ebdd9cb4fde29b3d8ffdb',
  'payroll.yearEnd.noFilings': '8b73cb6cd478b4ee9c958e53037f6a37cf8382749edee75a7ffd16d3ac0d6f16',
  'payroll.yearEnd.title': '9a63187ca66879c3edcaff1fd1159b7cde9fd6b66cd53ca0fbb3e7392ec8dd1f',
}


/**
 * True cognates and program codes that legitimately render identically to
 * English: the CPP/FICA register label names statutory programs, and
 * Net/Status are the ordinary French/German/Portuguese words.
 */
const PAYROLL_CHROME_COGNATES = new Set([
  'de:payroll.columns.status',
  'de:payroll.register.cppFica',
  'es:payroll.register.cppFica',
  'fr:payroll.columns.net',
  'fr:payroll.register.cppFica',
  'ja:payroll.register.cppFica',
  'pt-BR:payroll.columns.status',
  'pt-BR:payroll.register.cppFica',
  'zh:payroll.register.cppFica',
])

test('ar collections copy ships translated in every locale', () => {
  // F-x6-002: the recurring/subscriptions/dunning block (104 keys) existed
  // only in en/fr/es — de/ja/zh/pt-BR rendered English inside otherwise
  // translated AR screens. Every leaf must exist, keep its ICU
  // placeholders, and differ from English except for reviewed cognates,
  // which are pinned to their exact identical term.
  const identicalByFact = new Set([
    'de:ar.collections.dunning.stageLabels.name|Name',
    'de:ar.collections.subscriptions.planPlaceholder|Plan…',
    'de:ar.collections.subscriptions.plansTable.plan|Plan',
    'de:ar.collections.subscriptions.subsTable.plan|Plan',
    'de:ar.collections.subscriptions.subsTable.mrr|MRR',
    'de:ar.collections.subscriptions.subsTable.status|Status',
    'de:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'de:ar.collections.recurring.cronLabel|Cron',
    'de:ar.collections.recurring.table.status|Status',
    'ja:ar.collections.subscriptions.subsTable.mrr|MRR',
    'ja:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'ja:ar.collections.recurring.cronLabel|Cron',
    'zh:ar.collections.subscriptions.subsTable.mrr|MRR',
    'zh:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'zh:ar.collections.recurring.cronLabel|Cron',
    'pt-BR:ar.collections.subscriptions.subsTable.mrr|MRR',
    'pt-BR:ar.collections.subscriptions.subsTable.status|Status',
    'pt-BR:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'pt-BR:ar.collections.recurring.cronLabel|Cron',
    'pt-BR:ar.collections.recurring.table.status|Status',
    'pt-BR:ar.collections.dunning.tokensHint|Tokens:',
    'fr:ar.collections.recurring.cadenceLabel|Cadence',
    'fr:ar.collections.recurring.table.cadence|Cadence',
    'fr:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'fr:ar.collections.recurring.cronLabel|Cron',
    'es:ar.collections.subscriptions.planPlaceholder|Plan…',
    'es:ar.collections.subscriptions.plansTable.plan|Plan',
    'es:ar.collections.subscriptions.subsTable.plan|Plan',
    'es:ar.collections.subscriptions.subsTable.mrr|MRR',
    'es:ar.collections.recurring.no|No',
    'es:ar.collections.recurring.templateDocPlaceholder|INV-000123',
    'es:ar.collections.recurring.cronLabel|Cron',
    'es:ar.collections.dunning.tokensHint|Tokens:',
  ])
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter((key) => key.startsWith('ar.collections.'))
  assert.equal(wanted.length, 108, 'ar.collections source inventory changed; translate the new keys everywhere and re-pin')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} ar.collections translations drop or rename ICU placeholders`)
  }
})

test('agent workbench copy ships translated in every locale', () => {
  // F-x6-002: the agents namespace (92 keys) existed only in en/fr/es —
  // de/ja/zh/pt-BR rendered English inside otherwise translated screens.
  // Every leaf must exist, keep its ICU placeholders, and differ from
  // English except for reviewed cognates, pinned to the exact term.
  const identicalByFact = new Set([
    'de:agents.facets.pack|Pack',
    'de:agents.facets.status|Status',
    'de:agents.tabs.briefing|Briefing',
    'de:agents.drawer.assignment.team|Team',
    'de:agents.drawer.assignment.roles.administrator|Administrator',
    'de:agents.drawer.assignment.roles.controller|Controller',
    'pt-BR:agents.drawer.assignment.roles.controller|Controller',
    'pt-BR:agents.facets.status|Status',
    'fr:agents.metaTitle|Agents',
    'fr:agents.title|Agents',
    'fr:agents.tabs.briefing|Briefing',
    'fr:agents.drawer.notes.title|Notes',
  ])
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter((key) => key.startsWith('agents.'))
  assert.equal(wanted.length, 92, 'agents source inventory changed; translate the new keys everywhere and re-pin')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} agents translations drop or rename ICU placeholders`)
  }
})

test('payroll navigation chrome is translated in every locale', () => {
  // F-t08-018: the payroll module rendered fully English under fr while the
  // shell translated — the namespace had 5 keys per locale against 1077 in
  // English. These navigation-chrome namespaces (H1s, steps, table headers,
  // banners, buttons) now ship in every locale; deeper copy stays on the
  // tracked English fallback until a native review pass covers it.
  const source = flattenCatalog('en')
  const sourceKeys = [...source.keys()]
    .filter((key) => PAYROLL_CHROME_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix)))
    .sort()
  assert.deepEqual(
    sourceKeys,
    Object.keys(PAYROLL_CHROME_SOURCE_HASHES).sort(),
    'payroll chrome source inventory changed; translate the new keys everywhere and re-pin',
  )
  const changedSource = sourceKeys.filter(
    (key) => sha256(source.get(key) ?? '') !== PAYROLL_CHROME_SOURCE_HASHES[key],
  )
  assert.deepEqual(
    changedSource,
    [],
    'payroll chrome English copy changed; review every locale before updating the pinned hashes',
  )
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    const missing = sourceKeys.filter((key) => !catalog.has(key))
    const copiedEnglish = sourceKeys.filter(
      (key) => catalog.get(key) === source.get(key) && !PAYROLL_CHROME_COGNATES.has(`${locale}:${key}`),
    )
    // ICU placeholders are not prose: strip them before the stale check so
    // short labels like "{ran} von {total}" are judged on their words alone
    // (exact untranslated copies are already rejected by copiedEnglish).
    const prose = (value: string): string => value.replace(/\{[^}]*\}/g, ' ')
    const staleEnglish = sourceKeys.filter((key) => {
      const sourceValue = source.get(key)
      const localizedValue = catalog.get(key)
      return sourceValue !== undefined && localizedValue !== undefined && isAsciiEnglishCopy(prose(sourceValue), prose(localizedValue))
    })
    const placeholderDrift = sourceKeys.filter((key) => {
      // A `{name` match is only a placeholder when the name is followed by a
      // comma (plural/select argument) or a closing brace (simple argument).
      // ICU literal branches such as `=0 {Pay date is today}` or
      // `one {# employé}` are prose, not placeholders — counting `{Pay` or
      // `{#` as tokens would force every locale to echo English words.
      const tokens = (value: string): Set<string> =>
        new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(missing, [], `${locale} is missing payroll chrome translations`)
    assert.deepEqual(
      copiedEnglish,
      [],
      `${locale} contains source-English payroll chrome copy that would be counted as translated`,
    )
    assert.deepEqual(
      staleEnglish,
      [],
      `${locale} contains stale ASCII-only English payroll chrome prose`,
    )
    assert.deepEqual(
      placeholderDrift,
      [],
      `${locale} payroll chrome translations drop or rename ICU placeholders`,
    )
  }
})

const ADMIN_I1_IDENTICAL_BY_FACT = new Set([
    'es:admin.backupsManager.table.sha256|SHA-256',
    'es:admin.pageLayouts.blocks.panel|Panel',
    'es:admin.pageLayouts.status.personal|Personal',
    'es:admin.setup.fields.pensionable|Pensionable',
    'es:admin.setup.fields.planId|Plan',
    'es:admin.setup.options.holidayJurisdiction.caAb|Alberta',
    'es:admin.setup.options.holidayJurisdiction.caOn|Ontario',
    'es:admin.setup.options.holidayJurisdiction.caQc|Quebec',
    'es:admin.setup.options.holidayJurisdiction.caSk|Saskatchewan',
    'es:admin.setup.options.jurisdictionLevel.federal|Federal',
    'es:admin.setup.options.taxType.gst|GST',
    'es:admin.setup.options.taxType.hst|HST',
    'es:admin.setup.options.taxType.pst|PST',
    'es:admin.setup.options.taxType.qst|QST',
    'es:admin.setup.options.taxType.vat|VAT',
    'fr:admin.backupsManager.table.actionsSr|Actions',
    'fr:admin.backupsManager.table.archive|Archive',
    'fr:admin.backupsManager.table.sha256|SHA-256',
    'fr:admin.extensions.columns.version|Version',
    'fr:admin.extensions.draft.actionCount|Actions',
    'fr:admin.extensions.draft.screenKind.page|Page',
    'fr:admin.flows.runs.table.actions|Actions',
    'fr:admin.pageLayouts.blocks.pagination|Pagination',
    'fr:admin.pageLayouts.columns.module|Module',
    'fr:admin.pageLayouts.columns.note|Note',
    'fr:admin.pageLayouts.columns.route|Route',
    'fr:admin.pageLayouts.drawer.note|Note',
    'fr:admin.pageLayouts.tabs.structure|Structure',
    'fr:admin.setup.fields.dimension|Dimension',
    'fr:admin.setup.fields.observedOn|Date',
    'fr:admin.setup.options.holidayJurisdiction.caAb|Alberta',
    'fr:admin.setup.options.holidayJurisdiction.caOn|Ontario',
    'fr:admin.setup.options.holidayJurisdiction.caSk|Saskatchewan',
    'fr:admin.setup.options.payComponentCountry.CA|Canada',
])

test('admin backups/layouts/extensions copy ships translated in fr and es', () => {
  // F-i1-001: backupsManager, pageLayouts and extensions existed only in
  // en — fr/es rendered English inside otherwise translated admin screens.
  // Every leaf must exist, keep its ICU placeholders, and differ from
  // English except for reviewed cognates, pinned to the exact term.
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter(
    (key) =>
      key.startsWith('admin.backupsManager.') ||
      key.startsWith('admin.pageLayouts.') ||
      key.startsWith('admin.extensions.'),
  )
  assert.equal(wanted.length, 219, 'admin section source inventory changed; translate the new keys in fr/es and re-pin')
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of ['fr', 'es']) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...ADMIN_I1_IDENTICAL_BY_FACT].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} admin section translations drop or rename ICU placeholders`)
  }
})

test('admin setup and permissions copy ships translated in fr and es', () => {
  // F-i1-002: 409 scattered admin leaves (setup fields/help/options, feature
  // descriptions, impacts, permissions, custom-field kinds, hub/flows/roles/
  // scripts/settings/users) existed only in en. Same contract as above.
  const wanted = [
    'admin.customFields.kinds.header.cardCharge',
    'admin.customFields.kinds.header.cardRefund',
    'admin.customFields.kinds.header.check',
    'admin.customFields.kinds.header.customerCredit',
    'admin.customFields.kinds.header.vendorCredit',
    'admin.customFields.kinds.lines.cardCharge',
    'admin.customFields.kinds.lines.cardRefund',
    'admin.customFields.kinds.lines.check',
    'admin.customFields.kinds.lines.customerCredit',
    'admin.customFields.kinds.lines.vendorCredit',
    'admin.features.advancedClose.description',
    'admin.features.advancedSubscriptions.description',
    'admin.features.allocations.description',
    'admin.features.allocationsAtEntry.description',
    'admin.features.allocationsAtPosting.description',
    'admin.features.apiAccess.description',
    'admin.features.mcpAccess.description',
    'admin.features.multiCurrency.description',
    'admin.features.multiSubsidiary.description',
    'admin.features.payroll.description',
    'admin.features.projectScheduling.description',
    'admin.features.propertyManagement.description',
    'admin.features.queryConsole.description',
    'admin.features.scripts.description',
    'admin.features.subcontracts.description',
    'admin.features.wipBilling.description',
    'admin.flows.runs.retried',
    'admin.flows.runs.retry',
    'admin.flows.runs.retryFailed',
    'admin.flows.runs.retrying',
    'admin.flows.runs.table.actions',
    'admin.hub.cards.flows.description',
    'admin.hub.cards.flows.title',
    'admin.hub.cards.queryConsole.description',
    'admin.hub.cards.queryConsole.title',
    'admin.hub.cards.sandboxes.description',
    'admin.hub.cards.sandboxes.title',
    'admin.hub.groups.platform',
    'admin.permissions.admin_sandboxes_manage',
    'admin.permissions.allocations_approve',
    'admin.permissions.allocations_manage',
    'admin.permissions.allocations_read',
    'admin.permissions.allocations_run',
    'admin.permissions.groups.allocations',
    'admin.permissions.groups.payroll',
    'admin.permissions.payroll_manage',
    'admin.permissions.payroll_read',
    'admin.permissions.payroll_run',
    'admin.roles.drawer.inactivePermissions',
    'admin.roles.drawer.permissionsLoadFailed',
    'admin.scripts.drawer.copyUrl',
    'admin.scripts.drawer.endpointUrl',
    'admin.scripts.drawer.endpointUrlHint',
    'admin.scripts.drawer.urlCopied',
    'admin.scripts.triggers.customGlLines',
    'admin.settings.controlAccounts.defaultsNote',
    'admin.settings.controlAccounts.fields.retainagePayable.hint',
    'admin.settings.controlAccounts.fields.retainagePayable.label',
    'admin.settings.organization.perEntityNote',
    'admin.settings.organization.subsidiariesLink',
    'admin.setup.entities.account-groups.description',
    'admin.setup.entities.allocations.description',
    'admin.setup.entities.allocations.singular',
    'admin.setup.entities.entitlement-plan-limits.description',
    'admin.setup.entities.entitlement-plan-limits.singular',
    'admin.setup.entities.entitlement-plans.description',
    'admin.setup.entities.entitlement-plans.singular',
    'admin.setup.entities.entitlement-service-tiers.description',
    'admin.setup.entities.entitlement-service-tiers.singular',
    'admin.setup.entities.extension-settings.description',
    'admin.setup.entities.overhead-model.application.systemRule.body',
    'admin.setup.entities.overhead-model.application.systemRule.noVersion',
    'admin.setup.entities.overhead-model.application.systemRule.viewRule',
    'admin.setup.entities.pay-components.description',
    'admin.setup.entities.pay-derived-rules.description',
    'admin.setup.entities.pay-schedules.description',
    'admin.setup.entities.payroll-filing-accounts.description',
    'admin.setup.entities.payroll-holidays.description',
    'admin.setup.entities.payroll-holidays.singularTitle',
    'admin.setup.entities.subsidiary-ownership-interests.description',
    'admin.setup.entities.subsidiary-ownership-interests.singularTitle',
    'admin.setup.entities.tax-first-year-rules.description',
    'admin.setup.entities.tax-first-year-rules.singularTitle',
    'admin.setup.entities.tax-jurisdictions.description',
    'admin.setup.entities.tax-jurisdictions.singularTitle',
    'admin.setup.entities.tax-pool-classes.description',
    'admin.setup.entities.tax-pool-classes.singularTitle',
    'admin.setup.entities.tax-regimes.description',
    'admin.setup.entities.tax-regimes.singularTitle',
    'admin.setup.entities.tax-registrations.description',
    'admin.setup.entities.tax-registrations.singularTitle',
    'admin.setup.entities.trades.description',
    'admin.setup.entities.union-agreements.description',
    'admin.setup.features.affectsNote',
    'admin.setup.features.blockedReason',
    'admin.setup.features.childOptions',
    'admin.setup.features.confirmDisable',
    'admin.setup.features.countOn',
    'admin.setup.features.impacts.activeAllocationRules',
    'admin.setup.features.impacts.activeApiKeys',
    'admin.setup.features.impacts.activeBankFeeds',
    'admin.setup.features.impacts.activeBankImportSchedules',
    'admin.setup.features.impacts.activeProjects',
    'admin.setup.features.impacts.activePropertyLeases',
    'admin.setup.features.impacts.activeScripts',
    'admin.setup.features.impacts.activeSubcontractPaymentControls',
    'admin.setup.features.impacts.activeSubcontracts',
    'admin.setup.features.impacts.activeSubscriptions',
    'admin.setup.features.impacts.activeWipHolds',
    'admin.setup.features.impacts.advancedSubscriptionContracts',
    'admin.setup.features.impacts.assets',
    'admin.setup.features.impacts.bankStatements',
    'admin.setup.features.impacts.controlCheckUnavailable',
    'admin.setup.features.impacts.foreignTxns',
    'admin.setup.features.impacts.inventoryMovements',
    'admin.setup.features.impacts.openChangeOrders',
    'admin.setup.features.impacts.openFieldTickets',
    'admin.setup.features.impacts.openOrders',
    'admin.setup.features.impacts.openPayApplications',
    'admin.setup.features.impacts.openPrebills',
    'admin.setup.features.impacts.openProjectBillingRequests',
    'admin.setup.features.impacts.openProjectDocuments',
    'admin.setup.features.impacts.openProjectTimeEntries',
    'admin.setup.features.impacts.openVendorPayApplications',
    'admin.setup.features.impacts.outstandingRetainage',
    'admin.setup.features.impacts.postedPayRuns',
    'admin.setup.features.impacts.previewedAllocationRuns',
    'admin.setup.features.impacts.projects',
    'admin.setup.features.impacts.reconciliations',
    'admin.setup.features.impacts.revenueSchedules',
    'admin.setup.features.impacts.scheduledTasks',
    'admin.setup.features.impacts.securityDepositTransactions',
    'admin.setup.features.impacts.submittedTimeEntries',
    'admin.setup.features.impacts.subsidiaryTxns',
    'admin.setup.fieldHelp.basisCapAmountPerPeriod',
    'admin.setup.fieldHelp.basisCapAmountPerYear',
    'admin.setup.fieldHelp.basisCapHoursPerPeriod',
    'admin.setup.fieldHelp.entitlementAccrualValue',
    'admin.setup.fieldHelp.entitlementAfterMonths',
    'admin.setup.fieldHelp.entitlementCapBehavior',
    'admin.setup.fieldHelp.entitlementDirection',
    'admin.setup.fieldHelp.entitlementLiabilityAccount',
    'admin.setup.fieldHelp.entitlementMaxBalance',
    'admin.setup.fieldHelp.entitlementNotifyBalance',
    'admin.setup.fieldHelp.entitlementPayoutComponent',
    'admin.setup.fieldHelp.entitlementScope',
    'admin.setup.fieldHelp.entitlementTierTarget',
    'admin.setup.fieldHelp.entitlementUnit',
    'admin.setup.fieldHelp.equipmentUnitId',
    'admin.setup.fieldHelp.excludeFromWages',
    'admin.setup.fieldHelp.excludedJobTitles',
    'admin.setup.fieldHelp.filingAccountDefault',
    'admin.setup.fieldHelp.holidayEffectiveTo',
    'admin.setup.fieldHelp.holidayIsObserved',
    'admin.setup.fieldHelp.holidayIsPaid',
    'admin.setup.fieldHelp.holidayJurisdiction',
    'admin.setup.fieldHelp.holidayName',
    'admin.setup.fieldHelp.holidayObservance',
    'admin.setup.fieldHelp.holidayPackKey',
    'admin.setup.fieldHelp.holidayRuleNth',
    'admin.setup.fieldHelp.holidayRuleOffset',
    'admin.setup.fieldHelp.holidayRuleWeekday',
    'admin.setup.fieldHelp.includeInDisposableEarnings',
    'admin.setup.fieldHelp.includedJobTitles',
    'admin.setup.fieldHelp.itemId',
    'admin.setup.fieldHelp.maxAssessable',
    'admin.setup.fieldHelp.payScheduleAnchor',
    'admin.setup.fieldHelp.protectionBase',
    'admin.setup.fieldHelp.protectionMaxPercent',
    'admin.setup.fieldHelp.protectionPriority',
    'admin.setup.fieldHelp.stateCode',
    'admin.setup.fields.accountNumber',
    'admin.setup.fields.accrualComponentId',
    'admin.setup.fields.accrualMethod',
    'admin.setup.fields.accrualValue',
    'admin.setup.fields.acquisitionCost',
    'admin.setup.fields.acquisitionDate',
    'admin.setup.fields.acquisitionRate',
    'admin.setup.fields.afterMonths',
    'admin.setup.fields.anchorPeriodEnd',
    'admin.setup.fields.basisCapAmountPerPeriod',
    'admin.setup.fields.basisCapAmountPerYear',
    'admin.setup.fields.basisCapHoursPerPeriod',
    'admin.setup.fields.billableOnly',
    'admin.setup.fields.capBehavior',
    'admin.setup.fields.color',
    'admin.setup.fields.componentId',
    'admin.setup.fields.costingMode',
    'admin.setup.fields.dimension',
    'admin.setup.fields.direction',
    'admin.setup.fields.distributionAccountId',
    'admin.setup.fields.distributionIncomeAccountId',
    'admin.setup.fields.eligible',
    'admin.setup.fields.employeePartyId',
    'admin.setup.fields.equipmentUnitId',
    'admin.setup.fields.equityIncomeAccountId',
    'admin.setup.fields.excludeFromWages',
    'admin.setup.fields.excludedJobTitles',
    'admin.setup.fields.expenseAccountId',
    'admin.setup.fields.extensionKey',
    'admin.setup.fields.fairValueAdjustmentAccountId',
    'admin.setup.fields.fairValueNetAssets',
    'admin.setup.fields.filingFrequency',
    'admin.setup.fields.frequency',
    'admin.setup.fields.goodwillAccountId',
    'admin.setup.fields.includeInDisposableEarnings',
    'admin.setup.fields.includedJobTitles',
    'admin.setup.fields.insurable',
    'admin.setup.fields.investmentAccountId',
    'admin.setup.fields.isObserved',
    'admin.setup.fields.isPaid',
    'admin.setup.fields.jobTitle',
    'admin.setup.fields.jurisdiction',
    'admin.setup.fields.jurisdictionId',
    'admin.setup.fields.key',
    'admin.setup.fields.level',
    'admin.setup.fields.liabilityAccountId',
    'admin.setup.fields.localNumber',
    'admin.setup.fields.maxAssessable',
    'admin.setup.fields.maxBalance',
    'admin.setup.fields.nciEquityAccountId',
    'admin.setup.fields.nciFairValue',
    'admin.setup.fields.nciIncomeAccountId',
    'admin.setup.fields.nciMeasurement',
    'admin.setup.fields.nonPeriodic',
    'admin.setup.fields.notifyBalance',
    'admin.setup.fields.observance',
    'admin.setup.fields.observedOn',
    'admin.setup.fields.ownershipPercent',
    'admin.setup.fields.packKey',
    'admin.setup.fields.parentSubsidiaryId',
    'admin.setup.fields.payDateOffsetDays',
    'admin.setup.fields.payoutComponentId',
    'admin.setup.fields.pensionable',
    'admin.setup.fields.periodsPerYear',
    'admin.setup.fields.planId',
    'admin.setup.fields.programType',
    'admin.setup.fields.protectionBase',
    'admin.setup.fields.protectionMaxPercent',
    'admin.setup.fields.protectionPriority',
    'admin.setup.fields.quantityMode',
    'admin.setup.fields.rateMode',
    'admin.setup.fields.rateValue',
    'admin.setup.fields.reason',
    'admin.setup.fields.registrationNumber',
    'admin.setup.fields.remittancePartyId',
    'admin.setup.fields.remitterType',
    'admin.setup.fields.returnFormCode',
    'admin.setup.fields.ruleDay',
    'admin.setup.fields.ruleKind',
    'admin.setup.fields.ruleMonth',
    'admin.setup.fields.ruleNth',
    'admin.setup.fields.ruleOffset',
    'admin.setup.fields.ruleWeekday',
    'admin.setup.fields.settingKey',
    'admin.setup.fields.sortOrder',
    'admin.setup.fields.stateCode',
    'admin.setup.fields.taxTreatment',
    'admin.setup.fields.taxType',
    'admin.setup.fields.taxable',
    'admin.setup.fields.timeTypeId',
    'admin.setup.fields.tradeId',
    'admin.setup.fields.trigger',
    'admin.setup.fields.unionName',
    'admin.setup.fields.unit',
    'admin.setup.fields.vacationable',
    'admin.setup.fields.value',
    'admin.setup.filterAll',
    'admin.setup.options.consolidationMethod.equity',
    'admin.setup.options.consolidationMethod.full',
    'admin.setup.options.consolidationMethod.proportionate',
    'admin.setup.options.derivedCosting.firstProjectOfDay',
    'admin.setup.options.derivedCosting.none',
    'admin.setup.options.derivedCosting.source',
    'admin.setup.options.derivedQuantity.count',
    'admin.setup.options.derivedQuantity.countNights',
    'admin.setup.options.derivedQuantity.sumBillAmount',
    'admin.setup.options.derivedQuantity.sumHours',
    'admin.setup.options.derivedQuantity.sumQuantity',
    'admin.setup.options.derivedRate.fixedPerUnit',
    'admin.setup.options.derivedRate.percentOfGross',
    'admin.setup.options.derivedRate.percentOfQuantity',
    'admin.setup.options.derivedRate.rateCard',
    'admin.setup.options.derivedTrigger.distinctDay',
    'admin.setup.options.derivedTrigger.distinctProjectDay',
    'admin.setup.options.derivedTrigger.equipmentCharge',
    'admin.setup.options.derivedTrigger.monthEnd',
    'admin.setup.options.derivedTrigger.nightStayed',
    'admin.setup.options.derivedTrigger.timeEntry',
    'admin.setup.options.entitlementAccrualMethod.fixedPerPeriod',
    'admin.setup.options.entitlementAccrualMethod.manual',
    'admin.setup.options.entitlementAccrualMethod.perHourWorked',
    'admin.setup.options.entitlementAccrualMethod.percentOfEarnings',
    'admin.setup.options.entitlementCapBehavior.autoPayout',
    'admin.setup.options.entitlementCapBehavior.block',
    'admin.setup.options.entitlementCapBehavior.warn',
    'admin.setup.options.entitlementDirection.accrue',
    'admin.setup.options.entitlementDirection.owe',
    'admin.setup.options.entitlementUnit.hours',
    'admin.setup.options.entitlementUnit.money',
    'admin.setup.options.filingFrequency.annual',
    'admin.setup.options.filingFrequency.bimonthly',
    'admin.setup.options.filingFrequency.monthly',
    'admin.setup.options.filingFrequency.quarterly',
    'admin.setup.options.filingFrequency.semiannual',
    'admin.setup.options.holidayJurisdiction.ca',
    'admin.setup.options.holidayJurisdiction.caAb',
    'admin.setup.options.holidayJurisdiction.caBc',
    'admin.setup.options.holidayJurisdiction.caOn',
    'admin.setup.options.holidayJurisdiction.caQc',
    'admin.setup.options.holidayJurisdiction.caSk',
    'admin.setup.options.holidayJurisdiction.us',
    'admin.setup.options.holidayObservance.nearestWeekday',
    'admin.setup.options.holidayObservance.nextMonday',
    'admin.setup.options.holidayObservance.none',
    'admin.setup.options.holidayRuleKind.date',
    'admin.setup.options.holidayRuleKind.easterOffset',
    'admin.setup.options.holidayRuleKind.fixed',
    'admin.setup.options.holidayRuleKind.nthWeekday',
    'admin.setup.options.holidayRuleKind.weekdayBefore',
    'admin.setup.options.jurisdictionLevel.city',
    'admin.setup.options.jurisdictionLevel.country',
    'admin.setup.options.jurisdictionLevel.county',
    'admin.setup.options.jurisdictionLevel.federal',
    'admin.setup.options.jurisdictionLevel.special',
    'admin.setup.options.jurisdictionLevel.state',
    'admin.setup.options.nciMeasurement.fairValue',
    'admin.setup.options.nciMeasurement.proportionate',
    'admin.setup.options.payComponentBasis.fixedAmount',
    'admin.setup.options.payComponentBasis.perHour',
    'admin.setup.options.payComponentBasis.percentOfGross',
    'admin.setup.options.payComponentCountry.CA',
    'admin.setup.options.payComponentCountry.US',
    'admin.setup.options.payComponentKind.deduction',
    'admin.setup.options.payComponentKind.earning',
    'admin.setup.options.payComponentKind.employerContribution',
    'admin.setup.options.payFrequency.biweekly',
    'admin.setup.options.payFrequency.monthly',
    'admin.setup.options.payFrequency.semiMonthly',
    'admin.setup.options.payFrequency.weekly',
    'admin.setup.options.payProtectionBase.disposableEarnings',
    'admin.setup.options.payProtectionBase.gross',
    'admin.setup.options.payProtectionBase.netPay',
    'admin.setup.options.payProtectionBase.none',
    'admin.setup.options.payTaxTreatment.alimony',
    'admin.setup.options.payTaxTreatment.none',
    'admin.setup.options.payTaxTreatment.pensionF',
    'admin.setup.options.payTaxTreatment.unionDues',
    'admin.setup.options.payrollProgramType.caRp',
    'admin.setup.options.payrollProgramType.usEin',
    'admin.setup.options.payrollProgramType.usStateSui',
    'admin.setup.options.payrollRemitterType.accelerated1',
    'admin.setup.options.payrollRemitterType.accelerated2',
    'admin.setup.options.payrollRemitterType.quarterly',
    'admin.setup.options.payrollRemitterType.regular',
    'admin.setup.options.sourceKind.builtin',
    'admin.setup.options.sourceKind.custom',
    'admin.setup.options.taxType.consumption',
    'admin.setup.options.taxType.gst',
    'admin.setup.options.taxType.hst',
    'admin.setup.options.taxType.other',
    'admin.setup.options.taxType.pst',
    'admin.setup.options.taxType.qst',
    'admin.setup.options.taxType.salesUse',
    'admin.setup.options.taxType.vat',
    'admin.setup.paymentOperations.fields.cronHint',
    'admin.setup.paymentOperations.schedulePresets.daily',
    'admin.setup.paymentOperations.schedulePresets.monthly',
    'admin.setup.paymentOperations.schedulePresets.weekdays',
    'admin.setup.paymentOperations.schedulePresets.weekly',
    'admin.setup.sections.basisCaps',
    'admin.setup.sections.deductionProtection',
    'admin.setup.sections.holidayCompanyDay',
    'admin.setup.sections.holidayElection',
    'admin.setup.segmentValues.builtinLink',
    'admin.setup.segmentValues.builtinNotice',
    'admin.setup.segmentValues.builtinNoticeNoLink',
    'admin.setup.segmentValues.builtinTitle',
    'admin.setup.segmentValues.description',
    'admin.setup.segmentValues.empty',
    'admin.setup.segmentValues.new',
    'admin.setup.segmentValues.searchPlaceholder',
    'admin.setup.taxSetup.countryPackReady',
    'admin.setup.taxSetup.countryTaxSetup',
    'admin.setup.taxSetup.detailedPack',
    'admin.setup.taxSetup.installed',
    'admin.setup.taxSetup.jurisdictionSetup',
    'admin.setup.taxSetup.packInDevelopment',
    'admin.setup.taxSetup.provisionHint',
    'admin.setup.taxSetup.provisionSelected',
    'admin.setup.taxSetup.provisionSuccess',
    'admin.setup.taxSetup.provisioning',
    'admin.setup.taxSetup.searchPlaceholder',
    'admin.setup.taxSetup.statesAvailable',
    'admin.setup.taxSetup.statesSelected',
    'admin.setup.taxSetup.step1.description',
    'admin.setup.taxSetup.step1.title',
    'admin.setup.taxSetup.step2.cta',
    'admin.setup.taxSetup.step2.description',
    'admin.setup.taxSetup.step2.stat',
    'admin.setup.taxSetup.step2.title',
    'admin.setup.taxSetup.step3.cta',
    'admin.setup.taxSetup.step3.description',
    'admin.setup.taxSetup.step3.stat',
    'admin.setup.taxSetup.step3.title',
    'admin.setup.taxSetup.subtitle',
    'admin.setup.taxSetup.title',
    'admin.setup.taxSetup.toggleStates',
    'admin.users.unassignedRole',
  ] as const
  assert.equal(wanted.length, 409, 'admin scattered source inventory changed; translate the new keys in fr/es and re-pin')
  const source = flattenCatalog('en')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of ['fr', 'es']) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...ADMIN_I1_IDENTICAL_BY_FACT].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} admin scattered translations drop or rename ICU placeholders`)
  }
})

test('analytics copy ships translated in fr, es and de', () => {
  // i4: the analytics namespace (1883 keys) rendered English for the
  // customer, vendor, utilization, spendVelocity, sentinel, cashWeek and
  // categoryManager sections in fr/es/de. Every leaf must exist, keep its
  // ICU placeholders, and differ from English except for reviewed cognates,
  // pinned to the exact term. ja/zh/pt-BR are owned by sibling shards and
  // extend this pin when they land.
  const identicalByFact = new Set([
    "de:analytics.cashWeek.actionBar.summary|{count} {kind} · {total}",
    "de:analytics.cashWeek.meta.paymentTrend|Trend",
    "de:analytics.cashWeek.table.id|ID",
    "de:analytics.cashWeek.table.status|Status",
    "de:analytics.cashflow.vitals.arHint|(Cash + AR) / AP",
    "de:analytics.cashflow.vitals.cashCycleHint|DSO / DPO",
    "de:analytics.categoryManager.form.name|Name",
    "de:analytics.charts.bridge.start|Start",
    "de:analytics.common.monthYear|{month} ''{yy}",
    "de:analytics.common.monthsShort.apr|Apr",
    "de:analytics.common.monthsShort.aug|Aug",
    "de:analytics.common.monthsShort.feb|Feb",
    "de:analytics.common.monthsShort.jan|Jan",
    "de:analytics.common.monthsShort.jul|Jul",
    "de:analytics.common.monthsShort.jun|Jun",
    "de:analytics.common.monthsShort.nov|Nov",
    "de:analytics.common.monthsShort.sep|Sep",
    "de:analytics.customer.csv.segment|Segment",
    "de:analytics.customer.panels.segmentCustomers|{segment} ({count})",
    "de:analytics.customer.profitTier.marginal|Marginal",
    "de:analytics.customer.table.f|F",
    "de:analytics.customer.table.mom|MoM",
    "de:analytics.customer.table.m|M",
    "de:analytics.customer.table.r|R",
    "de:analytics.customer.table.segment|Segment",
    "de:analytics.customer.tier.bronze|Bronze",
    "de:analytics.customer.tier.gold|Gold",
    "de:analytics.financialHealth.budget.columns.budget|Budget",
    "de:analytics.financialHealth.budget.columns.status|Status",
    "de:analytics.financialHealth.budget.csv|CSV",
    "de:analytics.financialHealth.ratios.rule_of_40.label|Rule of 40",
    "de:analytics.financialHealth.subKpi.roic|ROIC",
    "de:analytics.financialHealth.subKpi.rule40|Rule of 40",
    "de:analytics.financialHealth.tabs.budget|Budget",
    "de:analytics.hub.cards.sentinelTitle|Sentinel",
    "de:analytics.sentinel.coverage.benfordBold|Benford",
    "de:analytics.sentinel.flag.rsf|RSF",
    "de:analytics.sentinel.forensics.auditEvent|{actor} {verb} {table} {row}{fieldsFrag}",
    "de:analytics.sentinel.forensics.auditFields| ({fields})",
    "de:analytics.sentinel.kind.journal|Journal",
    "de:analytics.sentinel.kpi.benford|Benford",
    "de:analytics.sentinel.kpi.signal|Signal",
    "de:analytics.sentinel.sub.twoD|2D: {value}",
    "de:analytics.sentinel.table.z|Z",
    "de:analytics.sentinel.tabs.benford|Benford",
    "de:analytics.sentinel.title|Sentinel",
    "de:analytics.spendVelocity.detectors.zombie.label|Zombies",
    "de:analytics.spendVelocity.table.details|Details",
    "de:analytics.spendVelocity.table.sparkline|Sparkline",
    "de:analytics.spendVelocity.table.trend|Trend",
    "de:analytics.spendVelocity.tabs.trends|Trends",
    "de:analytics.trueCost.absorption.monthCell|M{n}",
    "de:analytics.trueCost.config.categoryCount|{count, number}",
    "de:analytics.trueCost.config.departmentCount|{count, number}",
    "de:analytics.trueCost.matrix.csv|CSV",
    "de:analytics.trueCost.presets.rate_hours|50/50",
    "de:analytics.trueCost.selling.aggregation|Aggregation",
    "de:analytics.trueCost.selling.median|Median",
    "de:analytics.trueCost.selling.namePlaceholder|Name",
    "de:analytics.trueCost.tabs.matrix|Matrix",
    "de:analytics.trueCost.tabs.trends|Trends",
    "de:analytics.utilization.heatmap|Heatmap",
    "de:analytics.utilization.outlook.neutral|Neutral",
    "de:analytics.utilization.sources.introTail|:",
    "de:analytics.utilization.subTabs.treemap|Treemap",
    "de:analytics.utilization.table.max|Maximum",
    "de:analytics.utilization.table.min|Minimum",
    "es:analytics.cashWeek.actionBar.summary|{count} {kind} · {total}",
    "es:analytics.cashWeek.table.id|ID",
    "es:analytics.cashflow.vitals.cashCycleHint|DSO / DPO",
    "es:analytics.common.monthYear|{month} ''{yy}",
    "es:analytics.customer.panels.segmentCustomers|{segment} ({count})",
    "es:analytics.customer.profitTier.marginal|Marginal",
    "es:analytics.customer.table.f|F",
    "es:analytics.customer.table.mom|MoM",
    "es:analytics.customer.table.m|M",
    "es:analytics.customer.table.r|R",
    "es:analytics.financialHealth.budget.csv|CSV",
    "es:analytics.financialHealth.subKpi.roic|ROIC",
    "es:analytics.financialHealth.tabs.ratios|Ratios",
    "es:analytics.hub.cards.sentinelTitle|Sentinel",
    "es:analytics.sentinel.coverage.benfordBold|Benford",
    "es:analytics.sentinel.drill.top|top {count}",
    "es:analytics.sentinel.flag.rsf|RSF",
    "es:analytics.sentinel.kpi.benford|Benford",
    "es:analytics.sentinel.forensics.auditFields| ({fields})",
    "es:analytics.sentinel.no|No",
    "es:analytics.sentinel.sequential.runTotal| — total {total} ({first} → {last})",
    "es:analytics.sentinel.sub.twoD|2D: {value}",
    "es:analytics.sentinel.table.doc1|Doc 1",
    "es:analytics.sentinel.table.doc2|Doc 2",
    "es:analytics.sentinel.table.z|Z",
    "es:analytics.sentinel.tabs.benford|Benford",
    "es:analytics.sentinel.title|Sentinel",
    "es:analytics.spendVelocity.table.detector|Detector",
    "es:analytics.spendVelocity.table.sparkline|Sparkline",
    "es:analytics.trueCost.absorption.monthCell|M{n}",
    "es:analytics.trueCost.allocation.base|Base",
    "es:analytics.trueCost.allocation.perFte|{currency}/FTE",
    "es:analytics.trueCost.cards.base|Base",
    "es:analytics.trueCost.cellFlyout.colTotal|Total",
    "es:analytics.trueCost.config.categoryCount|{count, number}",
    "es:analytics.trueCost.config.departmentCount|{count, number}",
    "es:analytics.trueCost.custom.typeManual|Manual",
    "es:analytics.trueCost.matrix.csv|CSV",
    "es:analytics.trueCost.presets.rate_hours|50/50",
    "es:analytics.trueCost.selling.defaultAdditionalName|G&A",
    "es:analytics.trueCost.selling.manual|Manual",
    "es:analytics.utilization.no|No",
    "es:analytics.utilization.outlook.favorable|Favorable",
    "es:analytics.utilization.outlook.neutral|Neutral",
    "es:analytics.utilization.sources.introTail|:",
    "es:analytics.utilization.subTabs.treemap|Treemap",
    "es:analytics.utilization.whatif.na|N/A",
    "fr:analytics.cashWeek.actionBar.summary|{count} {kind} · {total}",
    "fr:analytics.cashWeek.csvHeaders.date|Date",
    "fr:analytics.cashWeek.csvHeaders.type|Type",
    "fr:analytics.cashWeek.table.date|Date",
    "fr:analytics.cashWeek.table.id|ID",
    "fr:analytics.cashWeek.table.type|Type",
    "fr:analytics.cashflow.horizon.label|Horizon",
    "fr:analytics.cashflow.kpi.netSub|{change} net",
    "fr:analytics.cashflow.vitals.cashCycleHint|DSO / DPO",
    "fr:analytics.categoryManager.form.type|Type",
    "fr:analytics.charts.weekly.net|Net",
    "fr:analytics.common.monthYear|{month} ''{yy}",
    "fr:analytics.customer.csv.segment|Segment",
    "fr:analytics.customer.insights.scoreExcellent|Excellent",
    "fr:analytics.customer.kpi.champions|Champions",
    "fr:analytics.customer.kpi.excellent|Excellent",
    "fr:analytics.customer.margin.excellent|Excellent",
    "fr:analytics.customer.panels.segmentCustomers|{segment} ({count})",
    "fr:analytics.customer.profitTier.marginal|Marginal",
    "fr:analytics.customer.segment.champions|Champions",
    "fr:analytics.customer.sub.score40to59|score 40–59",
    "fr:analytics.customer.sub.score80Plus|score ≥ 80",
    "fr:analytics.customer.sub.scoreBelow40|score < 40",
    "fr:analytics.customer.table.f|F",
    "fr:analytics.customer.table.mom|MoM",
    "fr:analytics.customer.table.m|M",
    "fr:analytics.customer.table.r|R",
    "fr:analytics.customer.table.score|Score",
    "fr:analytics.customer.table.segment|Segment",
    "fr:analytics.customer.tabs.configuration|Configuration",
    "fr:analytics.customer.tabs.segmentation|Segmentation",
    "fr:analytics.customer.tier.bronze|Bronze",
    "fr:analytics.financialHealth.budget.columns.budget|Budget",
    "fr:analytics.financialHealth.budget.columns.type|Type",
    "fr:analytics.financialHealth.budget.csv|CSV",
    "fr:analytics.financialHealth.score.excellent|Excellent",
    "fr:analytics.financialHealth.subKpi.roic|ROIC",
    "fr:analytics.financialHealth.tabs.budget|Budget",
    "fr:analytics.financialHealth.tabs.configuration|Configuration",
    "fr:analytics.financialHealth.tabs.ratios|Ratios",
    "fr:analytics.financialHealth.tabs.segments|Segments",
    "fr:analytics.hub.cards.sentinelTitle|Sentinel",
    "fr:analytics.sentinel.benford.acceptable|Acceptable",
    "fr:analytics.sentinel.benford.excellent|Excellent",
    "fr:analytics.sentinel.coverage.benfordBold|Benford",
    "fr:analytics.sentinel.drill.documentsTotal|{count} documents · {total}",
    "fr:analytics.sentinel.drill.top|top {count}",
    "fr:analytics.sentinel.flag.rsf|RSF",
    "fr:analytics.sentinel.kind.journal|Journal",
    "fr:analytics.sentinel.kpi.benford|Benford",
    "fr:analytics.sentinel.kpi.signal|Signal",
    "fr:analytics.sentinel.sequential.runTotal| — total {total} ({first} → {last})",
    "fr:analytics.sentinel.sub.documents|documents",
    "fr:analytics.sentinel.forensics.auditEvent|{actor} {verb} {table} {row}{fieldsFrag}",
    "fr:analytics.sentinel.forensics.auditFields| ({fields})",
    "fr:analytics.sentinel.table.action|Action",
    "fr:analytics.sentinel.table.date|Date",
    "fr:analytics.sentinel.table.doc1|Doc 1",
    "fr:analytics.sentinel.table.doc2|Doc 2",
    "fr:analytics.sentinel.table.document|Document",
    "fr:analytics.sentinel.table.members|Documents",
    "fr:analytics.sentinel.table.z|Z",
    "fr:analytics.sentinel.tabs.benford|Benford",
    "fr:analytics.sentinel.tabs.config|Configuration",
    "fr:analytics.sentinel.title|Sentinel",
    "fr:analytics.spendVelocity.config.fragmentation.label|Fragmentation",
    "fr:analytics.spendVelocity.detectors.anomaly.label|Anomalies",
    "fr:analytics.spendVelocity.detectors.concentration.label|Concentration",
    "fr:analytics.spendVelocity.detectors.fragmentation.label|Fragmentation",
    "fr:analytics.spendVelocity.detectors.zombie.label|Zombies",
    "fr:analytics.spendVelocity.sub.anomaliesCount|{count} anomalies",
    "fr:analytics.spendVelocity.table.impact|Impact",
    "fr:analytics.spendVelocity.table.sparkline|Sparkline",
    "fr:analytics.spendVelocity.tabs.config|Configuration",
    "fr:analytics.spendVelocity.trend.stable|Stable",
    "fr:analytics.trueCost.absorption.monthCell|M{n}",
    "fr:analytics.trueCost.allocation.base|Base",
    "fr:analytics.trueCost.cards.base|Base",
    "fr:analytics.trueCost.cards.source|Source",
    "fr:analytics.trueCost.cards.type|Type",
    "fr:analytics.trueCost.cellFlyout.colTotal|Total",
    "fr:analytics.trueCost.config.categoryCount|{count, number}",
    "fr:analytics.trueCost.config.departmentCount|{count, number}",
    "fr:analytics.trueCost.matrix.csv|CSV",
    "fr:analytics.trueCost.presets.rate_hours|50/50",
    "fr:analytics.trueCost.tabs.config|Configuration",
    "fr:analytics.utilization.outlook.favorable|Favorable",
    "fr:analytics.utilization.subTabs.anomalies|Anomalies",
    "fr:analytics.utilization.subTabs.treemap|Treemap",
    "fr:analytics.utilization.table.date|Date",
    "fr:analytics.utilization.table.max|Maximum",
    "fr:analytics.utilization.table.min|Minimum",
    "fr:analytics.utilization.tabs.config|Configuration",
    "fr:analytics.utilization.tabs.intelligence|Intelligence",
    "fr:analytics.utilization.whatif.na|N/A",
    "fr:analytics.vendor.kpi.hhi|Concentration (HHI)",
    "fr:analytics.vendor.quadrant.niche.label|Niche",
    "fr:analytics.vendor.table.score|Score",
  ])
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter((key) => key.startsWith('analytics.'))
  // ICU parity is pinned for the seven sections owned by shard i4; the
  // pre-existing sections carry select-branch prose braces (trueCost
  // scenarios render Reducing/Adding words, correctly translated)
  // that a brace-counting check cannot distinguish from placeholders.
  const icuOwned = [
    'analytics.customer.',
    'analytics.vendor.',
    'analytics.utilization.',
    'analytics.spendVelocity.',
    'analytics.sentinel.',
    'analytics.cashWeek.',
    'analytics.categoryManager.',
  ]
  const icuWanted = wanted.filter((key) => icuOwned.some((prefix) => key.startsWith(prefix)))
  assert.equal(icuWanted.length, 1276, 'analytics i4-section inventory changed; translate the new keys everywhere and re-pin')
  assert.equal(wanted.length, 1916, 'analytics source inventory changed; translate the new keys everywhere and re-pin')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const arms = (value: string): string[] => value.match(/, +(plural|select)/g) ?? []
  for (const locale of ['de', 'es', 'fr']) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = icuWanted.filter((key) => {
      // de:analytics.utilization.hotspot.others is the one deliberate
      // exception: the English-only `{s}` is a literal plural suffix with
      // no German counterpart ("weitere" is invariant) — the one/other arms
      // are still asserted below.
      if (locale === 'de' && key === 'analytics.utilization.hotspot.others') return false
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} analytics translations drop or rename ICU placeholders`)
    const armsDrift = icuWanted.filter((key) => {
      const expected = arms(source.get(key) ?? '').join(',')
      const actual = arms(catalog.get(key) ?? '').join(',')
      return expected !== actual
    })
    assert.deepEqual(armsDrift, [], `${locale} analytics translations drop ICU plural/select arms`)
  }
})

test('admin namespace ships translated in zh and pt-BR', () => {
  // i3: the admin namespace (3359 keys) was missing 1380 keys each in zh
  // and pt-BR — setup, ai agents, features, backups, page layouts and
  // extensions rendered English inside otherwise translated screens.
  // Every leaf must exist, keep its ICU placeholders, and differ from
  // English except for reviewed cognates, pinned to the exact term.
  // F-coord-008 grew the source to 3362 keys (allocatedThrough, dateBasis,
  // unitsTotal, depreciationMethodId); all four ship translated in zh/pt-BR.
  // HR-5 grew it to 3416 (leave-types/leave-policies entities, leave fields,
  // fieldHelp, leaveValueCrossing options, hrm.leave.* permission labels);
  // all 24 ship translated in zh/pt-BR. HR-9 grows it to 3464 with the
  // four hrm.self.*/hrm.team.* permission labels; all four ship
  // translated in zh/pt-BR.
  const identicalByFact = new Set([
    'zh:admin.ai.agents.units.percent|%',
    'zh:admin.backupsManager.table.sha256|SHA-256',
    'zh:admin.buildHub.groups.api|API',
    'zh:admin.customFields.drawer.keyPlaceholder|po_number',
    'zh:admin.features.apiAccess.title|REST API',
    'zh:admin.features.crm.title|CRM',
    'zh:admin.flows.targets.emailPlaceholder|ops@example.com, cfo@example.com',
    'zh:admin.hub.cards.ai.title|AI',
    'zh:admin.roles.drawer.keyPlaceholder|ap_clerk',
    'zh:admin.settings.fiscal.range|{start} → {end}',
    'zh:admin.settings.organization.displayNamePlaceholder|Acme Manufacturing',
    'zh:admin.settings.organization.legalNamePlaceholder|Acme Manufacturing Inc.',
    'zh:admin.setup.entities.sftp.title|SFTP',
    'zh:admin.setup.fieldHelp.expiryWarningDaysHint|30',
    'zh:admin.setup.fieldHelp.graceDaysHint|0',
    'zh:admin.setup.fxProvider.providers.open_exchange_rates|Open Exchange Rates',
    'zh:admin.setup.laborCosting.wizard.ratePlaceholder|0.00',
    'zh:admin.setup.options.informationReturnForm.misc|1099-MISC',
    'zh:admin.setup.options.informationReturnForm.nec|1099-NEC',
    'zh:admin.setup.options.informationReturnForm.t4a|T4A',
    'zh:admin.setup.options.macrsSystem.ads|ADS',
    'zh:admin.setup.options.macrsSystem.gds|GDS',
    'zh:admin.setup.options.taxType.gst|GST',
    'zh:admin.setup.options.taxType.hst|HST',
    'zh:admin.setup.options.taxType.pst|PST',
    'zh:admin.setup.options.taxType.qst|QST',
    'zh:admin.setup.paymentOperations.rails.positive_pay|Positive Pay',
    'zh:admin.setup.paymentOperations.schemes.nacha|NACHA',
    'zh:admin.setup.paymentOperations.schemes.sepa_b2b|SEPA B2B',
    'zh:admin.setup.paymentOperations.schemes.sepa_core|SEPA Core',
    'pt-BR:admin.ai.agents.parameterLabel|{label} ({unit})',
    'pt-BR:admin.ai.agents.units.percent|%',
    'pt-BR:admin.apiKeys.table.status|Status',
    'pt-BR:admin.audit.drawer.item|Item',
    'pt-BR:admin.backupsManager.table.sha256|SHA-256',
    'pt-BR:admin.backupsManager.table.status|Status',
    'pt-BR:admin.buildHub.groups.api|API',
    'pt-BR:admin.customFields.drawer.keyPlaceholder|po_number',
    'pt-BR:admin.customFields.drawer.placeholder|Placeholder',
    'pt-BR:admin.customFields.drawer.roleController|Controller',
    'pt-BR:admin.customFields.table.status|Status',
    'pt-BR:admin.extensions.columns.status|Status',
    'pt-BR:admin.extensions.status|Status',
    'pt-BR:admin.extensions.title|Apps',
    'pt-BR:admin.features.apps.title|Apps',
    'pt-BR:admin.features.bankFeeds.title|Bank Feeds',
    'pt-BR:admin.features.crm.title|CRM',
    'pt-BR:admin.features.scripts.title|Scripts',
    'pt-BR:admin.flows.runs.table.status|Status',
    'pt-BR:admin.flows.table.status|Status',
    'pt-BR:admin.hub.cards.backup.title|Backups',
    'pt-BR:admin.hub.cards.scripts.title|Scripts',
    'pt-BR:admin.pageLayouts.columns.status|Status',
    'pt-BR:admin.pageLayouts.status.filter|Status',
    'pt-BR:admin.permissions.groups.insights|Insights',
    'pt-BR:admin.roles.drawer.keyPlaceholder|ap_clerk',
    'pt-BR:admin.scripts.drawer.runStatus.ok|ok',
    'pt-BR:admin.scripts.table.script|Script',
    'pt-BR:admin.scripts.table.status|Status',
    'pt-BR:admin.scripts.title|Scripts',
    'pt-BR:admin.scripts.triggers.endpoint|endpoint',
    'pt-BR:admin.settings.fiscal.frameworkAsc740|ASC 740 (US GAAP)',
    'pt-BR:admin.settings.fiscal.frameworkIas12|IAS 12 (IFRS)',
    'pt-BR:admin.settings.fiscal.range|{start} → {end}',
    'pt-BR:admin.settings.fiscal.reportingFrameworkIfrs|IFRS',
    'pt-BR:admin.settings.fiscal.reportingFrameworkUsGaap|US GAAP',
    'pt-BR:admin.settings.organization.displayNamePlaceholder|Acme Manufacturing',
    'pt-BR:admin.settings.organization.legalNamePlaceholder|Acme Manufacturing Inc.',
    'pt-BR:admin.settings.organization.reportPdfStyleFormal|Formal (GAAP)',
    'pt-BR:admin.setup.agents.activity.statusColumn|Status',
    'pt-BR:admin.setup.agents.activity.triggers.manual|Manual',
    'pt-BR:admin.setup.agents.overview.columns.status|Status',
    'pt-BR:admin.setup.entities.classes.title|Classes',
    'pt-BR:admin.setup.entities.overhead-model.application.status|Status',
    'pt-BR:admin.setup.entities.overhead-model.lifecycle.modes.manual|Manual',
    'pt-BR:admin.setup.entities.sftp.title|SFTP',
    'pt-BR:admin.setup.fieldHelp.expiryWarningDaysHint|30',
    'pt-BR:admin.setup.fieldHelp.graceDaysHint|0',
    'pt-BR:admin.setup.fields.extensionKey|App',
    'pt-BR:admin.setup.fields.itemId|Item',
    'pt-BR:admin.setup.fields.regime|Regime',
    'pt-BR:admin.setup.fxProvider.providers.bank_of_canada|Bank of Canada',
    'pt-BR:admin.setup.fxProvider.providers.open_exchange_rates|Open Exchange Rates',
    'pt-BR:admin.setup.laborCosting.billing.item|Item',
    'pt-BR:admin.setup.laborCosting.billing.status|Status',
    'pt-BR:admin.setup.laborCosting.rates.status|Status',
    'pt-BR:admin.setup.laborCosting.wizard.ratePlaceholder|0.00',
    'pt-BR:admin.setup.options.costingMethod.fifo|FIFO',
    'pt-BR:admin.setup.options.holidayJurisdiction.caAb|Alberta',
    'pt-BR:admin.setup.options.holidayJurisdiction.caQc|Quebec',
    'pt-BR:admin.setup.options.holidayJurisdiction.caSk|Saskatchewan',
    'pt-BR:admin.setup.options.informationReturnBox.misc2|MISC 2 — Royalties',
    'pt-BR:admin.setup.options.informationReturnForm.misc|1099-MISC',
    'pt-BR:admin.setup.options.informationReturnForm.nec|1099-NEC',
    'pt-BR:admin.setup.options.informationReturnForm.t4a|T4A',
    'pt-BR:admin.setup.options.jurisdictionLevel.federal|Federal',
    'pt-BR:admin.setup.options.macrsSystem.ads|ADS',
    'pt-BR:admin.setup.options.macrsSystem.gds|GDS',
    'pt-BR:admin.setup.options.method.manual|Manual',
    'pt-BR:admin.setup.options.rateSource.manual|Manual',
    'pt-BR:admin.setup.options.taxType.gst|GST',
    'pt-BR:admin.setup.options.taxType.hst|HST',
    'pt-BR:admin.setup.options.taxType.pst|PST',
    'pt-BR:admin.setup.options.taxType.qst|QST',
    'pt-BR:admin.setup.paymentOperations.columns.status|Status',
    'pt-BR:admin.setup.paymentOperations.fields.status|Status',
    'pt-BR:admin.setup.paymentOperations.rails.cheque|Cheque',
    'pt-BR:admin.setup.paymentOperations.rails.positive_pay|Positive Pay',
    'pt-BR:admin.setup.paymentOperations.schemes.nacha|NACHA',
    'pt-BR:admin.setup.paymentOperations.schemes.sepa_b2b|SEPA B2B',
    'pt-BR:admin.setup.paymentOperations.schemes.sepa_core|SEPA Core',
    'pt-BR:admin.setup.taxBoxes.manual|Manual',
    'pt-BR:admin.setup.taxLibrary.status|Status',
    'pt-BR:admin.users.statusFilter|Status',
    'pt-BR:admin.automations.list.statusLabel|Status',
    'pt-BR:admin.automations.list.columnStatus|Status',
    'pt-BR:admin.automations.triggerKinds.manual|Manual',
    'pt-BR:admin.automations.builder.cronLabel|Cron',
    'pt-BR:admin.automations.builder.opLabel|Op',
    'pt-BR:admin.automations.builder.simulateSubjectPlaceholder|leave_request:<id>',
    'pt-BR:admin.automations.builder.stepStatus|Status',
    'pt-BR:admin.automations.builder.runStatus|Status',
    // HR-17: Feedback is the pt-BR product term, kept as in English.
    'pt-BR:admin.features.hrmFeedback.title|Feedback',
    'zh:admin.automations.builder.cronLabel|Cron',
    'zh:admin.automations.builder.simulateSubjectPlaceholder|leave_request:<id>',
  ])
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter((key) => key.startsWith('admin.'))
  // HR-17: 3844 = 3825 on b4b4fe256 plus 19 continuous-performance keys
  // (6 features, 2 setup entities, 1 setup field); zh/pt-BR completeness
  // is asserted per-key below.
  // HR-17 + HR-18: 3906 = 3844 on 12359058e (3825 plus 19 continuous-performance
  // keys) plus 62 recruiting-depth keys; zh/pt-BR completeness is asserted per-key below.
  // HR-21: re-pinned to the value this assertion printed on the merged
  // tree after the AI-rails admin copy landed. Never arithmetic and never
  // a number measured on another branch -- the count is whatever the
  // English catalog actually holds here.
  // m17_hrm_ui/F5: 4050 = 4041 plus 3 HR permission labels (b1b1c7b22) plus 6 pipeline-entity keys (2 entities x
  // title/singularTitle/description), translated in all 7 locales.
  // m17_hrm_ui/F5-followup: 4062 = 4050 plus 12 rehomed-entity keys
  // (ai-rails-settings, hrm-action-reasons, qualification-types,
  // qualification-settings), translated in all 7 locales.
  // m23_insights_autosave/F1: 4069 = 4063 plus 6 flow-builder keyboard
  // connect keys (builder.inspector.connect*), translated in all 7 locales.
  // CTRL-01 (+7) + UX-19 (+3) + g22 UX-17 (+5 redirect/home keys): 4084 = 4069 + 15, all 7 locales.
  // TZ1 (+5 business-time-zone keys: settings.organization timeZone/timeZoneHint/
  // timeZonePlaceholder, wizard.company.timeZone, wizard.review.timeZone):
  // 4089 = 4084 + 5, all 7 locales.
  // g31/IN11 (+2 stock-count independent-review keys:
  // settings.approvals requireStockCountReview/requireStockCountReviewHint):
  // 4091 = 4089 + 2, all 7 locales.
  // +2 from main (recognition-rule policy keys, translated by their shard):
  // 4093 = 4091 + 2.
  assert.equal(wanted.length, 4093, 'admin source inventory changed; translate the new keys in zh/pt-BR and re-pin')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  for (const locale of ['pt-BR', 'zh']) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} admin translations drop or rename ICU placeholders`)
  }
})

test('analytics copy ships translated in ja, zh and pt-BR', () => {
  // i5: the cashWeek/categoryManager/customer/sentinel/spendVelocity/
  // utilization/vendor subtrees (1251 keys) were missing wholesale in
  // ja/zh/pt-BR, which rendered English inside otherwise translated
  // analytics screens. Every leaf under those subtrees must exist, keep
  // its ICU placeholders and plural/select arms, and differ from English
  // except for reviewed cognates/codes/formats, pinned to the exact term.
  const identicalByFact = new Set([
    'ja:analytics.cashWeek.table.id|ID',
    'ja:analytics.categoryManager.form.memoKeywordsPlaceholder|payroll, lease, hydro…',
    'ja:analytics.customer.table.f|F',
    'ja:analytics.customer.table.m|M',
    'ja:analytics.customer.table.r|R',
    'ja:analytics.sentinel.flag.rsf|RSF',
    'ja:analytics.sentinel.table.z|Z',
    'ja:analytics.sentinel.title|Sentinel',
    'ja:analytics.utilization.whatif.na|N/A',
    'zh:analytics.cashWeek.table.id|ID',
    'zh:analytics.categoryManager.form.memoKeywordsPlaceholder|payroll, lease, hydro…',
    'zh:analytics.customer.table.f|F',
    'zh:analytics.customer.table.m|M',
    'zh:analytics.customer.table.r|R',
    'zh:analytics.sentinel.flag.rsf|RSF',
    'zh:analytics.sentinel.forensics.auditEvent|{actor} {verb} {table} {row}{fieldsFrag}',
    'zh:analytics.sentinel.table.z|Z',
    'zh:analytics.sentinel.title|Sentinel',
    'zh:analytics.utilization.whatif.na|N/A',
    'pt-BR:analytics.cashWeek.actionBar.summary|{count} {kind} · {total}',
    'pt-BR:analytics.cashWeek.table.id|ID',
    'pt-BR:analytics.cashWeek.table.status|Status',
    'pt-BR:analytics.categoryManager.form.memoKeywordsPlaceholder|payroll, lease, hydro…',
    'pt-BR:analytics.customer.csv.churn|Churn',
    'pt-BR:analytics.customer.panels.segmentCustomers|{segment} ({count})',
    'pt-BR:analytics.customer.profitTier.marginal|Marginal',
    'pt-BR:analytics.customer.table.churn|Churn',
    'pt-BR:analytics.customer.table.f|F',
    'pt-BR:analytics.customer.table.m|M',
    'pt-BR:analytics.customer.table.r|R',
    'pt-BR:analytics.customer.tier.bronze|Bronze',
    'pt-BR:analytics.sentinel.forensics.auditEvent|{actor} {verb} {table} {row}{fieldsFrag}',
    'pt-BR:analytics.sentinel.forensics.auditFields| ({fields})',
    'pt-BR:analytics.sentinel.analysis.zscoreWord|Z-score',
    'pt-BR:analytics.sentinel.coverage.benfordBold|Benford',
    'pt-BR:analytics.sentinel.drill.top|top {count}',
    'pt-BR:analytics.sentinel.flag.rsf|RSF',
    'pt-BR:analytics.sentinel.kpi.benford|Benford',
    'pt-BR:analytics.sentinel.sub.twoD|2D: {value}',
    'pt-BR:analytics.sentinel.table.doc1|Doc 1',
    'pt-BR:analytics.sentinel.table.doc2|Doc 2',
    'pt-BR:analytics.sentinel.table.z|Z',
    'pt-BR:analytics.sentinel.tabs.benford|Benford',
    'pt-BR:analytics.sentinel.title|Sentinel',
    'pt-BR:analytics.spendVelocity.panels.insights|Insights',
    'pt-BR:analytics.spendVelocity.table.detector|Detector',
    'pt-BR:analytics.spendVelocity.table.item|Item',
    'pt-BR:analytics.utilization.entries.item|Item',
    'pt-BR:analytics.utilization.sources.introTail|:',
    'pt-BR:analytics.utilization.whatif.na|N/A',
    'pt-BR:analytics.vendor.quadrant.commodity.label|Commodity',
  ])
  const pinnedLocales = ['ja', 'pt-BR', 'zh']
  const prefixes = [
    'analytics.cashWeek.',
    'analytics.categoryManager.',
    'analytics.customer.',
    'analytics.sentinel.',
    'analytics.spendVelocity.',
    'analytics.utilization.',
    'analytics.vendor.',
  ]
  const source = flattenCatalog('en')
  const wanted = [...source.keys()].filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
  assert.equal(wanted.length, 1276, 'analytics i5-subtree inventory changed; translate the new keys in ja/zh/pt-BR and re-pin')
  for (const key of wanted) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const arms = (value: string): string[] =>
    [...(value.match(/(one|other|few|many|zero|two)\s*\{/g) ?? [])].map((arm) => arm.replace(/\s*\{$/, ''))
  for (const locale of pinnedLocales) {
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...identicalByFact].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const english = source.get(key) ?? ''
      const expected = tokens(english)
      const actual = tokens(catalog.get(key) ?? '')
      // `{s}` in `other {s}` is plural morphology, not a data placeholder:
      // pt keeps it (outro/outros), ja/zh empty the arm (no plural marking).
      if (english.includes('other {s}')) {
        expected.delete('{s')
        actual.delete('{s')
      }
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} analytics translations drop or rename ICU placeholders`)
    const armDrift = wanted.filter((key) => {
      const expected = [...new Set(arms(source.get(key) ?? ''))].sort()
      const actual = [...new Set(arms(catalog.get(key) ?? ''))].sort()
      return expected.join(',') !== actual.join(',')
    })
    assert.deepEqual(armDrift, [], `${locale} analytics translations drop ICU plural/select arms`)
  }
})

test('admin copy ships translated in de and ja (i2)', () => {
  // i2 owns web/messages/{de,ja}/admin.json: the admin namespace must be
  // fully present and non-English in both locales, with ICU placeholder
  // parity. ADMIN_I2_COGNATES exempts deliberate keeps: statutory codes
  // (VAT/GST/HST/PST/QST, 1099-NEC/MISC, T4A, NEC/MISC/T4A boxes,
  // RPP/RRSP/U1/F2/RP/EIN/SUI, TD1/W-4, CPP/EI/WSIB/EHT/FICA/FUTA/SUTA,
  // ASC 740, IAS 12, IFRS, US GAAP, FIFO, ADS/GDS, NACHA, SEPA,
  // Positive Pay, SHA-256), brand names (Bank of Canada, ECB,
  // Open Exchange Rates), product terms spelled as in English (API,
  // SFTP, CRM, Apps, Flows, SaaS, WIP, Status, Code, Import & Export,
  // County, Live, Standard, Live/Standard overhead methods), example
  // placeholders (Acme names, ap_clerk, po_number, sample e-mails,
  // the Saunders example company, boxing_day/heritage_day keys, cron
  // syntax) and code-heavy labels whose only English-looking words are
  // shared identifiers. Anything pasted back in English outside this
  // list fails.
  const ADMIN_I2_COGNATES = new Set([
    // RM3: "Version" is the German term for a rule version, identical to English.
    'de:admin.setup.fields.version',
    // HR-17: Feedback is the German product term (Duden loanword), kept as in English.
    'de:admin.features.hrmFeedback.title',
    'de:admin.users.linkPersonLabel',
    'de:admin.automations.builder.cronLabel',
    'de:admin.automations.builder.nameTitle',
    'de:admin.automations.builder.opLabel',
    'de:admin.automations.builder.rule_positionId',
    'de:admin.automations.builder.runStatus',
    'de:admin.automations.builder.runVersion',
    'de:admin.automations.builder.stepDetail',
    'de:admin.automations.builder.stepStatus',
    'de:admin.automations.builder.triggerTitle',
    'de:admin.automations.list.columnStatus',
    'de:admin.automations.list.columnTrigger',
    'de:admin.automations.list.nameLabel',
    'de:admin.automations.list.statusLabel',
    'de:admin.automations.list.triggerLabel',
    'de:admin.features.automationSimulator.title',
    'ja:admin.automations.builder.cronLabel',
    'ja:admin.automations.builder.simulateSubjectPlaceholder',
    'de:admin.ai.agents.parameterLabel',
    'de:admin.ai.agents.units.percent',
    'de:admin.apiKeys.table.name',
    'de:admin.apiKeys.table.status',
    'de:admin.backupsManager.alerts.workerOfflineTitle',
    'de:admin.backupsManager.table.manifest',
    'de:admin.backupsManager.table.sha256',
    'de:admin.backupsManager.table.status',
    'de:admin.buildHub.groups.api',
    'de:admin.customFields.drawer.keyPlaceholder',
    'de:admin.customFields.drawer.max',
    'de:admin.customFields.drawer.min',
    'de:admin.customFields.drawer.optionalSuffix',
    'de:admin.customFields.drawer.roleController',
    'de:admin.customFields.table.status',
    'de:admin.customFields.types.text.label',
    'de:admin.extensions.columns.name',
    'de:admin.extensions.columns.status',
    'de:admin.extensions.columns.version',
    'de:admin.extensions.status',
    'de:admin.extensions.title',
    'de:admin.features.apps.title',
    'de:admin.features.banking.title',
    'de:admin.features.budgets.title',
    'de:admin.features.crm.title',
    // HR-18: Recruiting is the German product term (Duden-listed), not
    // untranslated English.
    'de:admin.features.hrmRecruiting.title',
    'de:admin.flows.gate.mode',
    'de:admin.flows.new.name',
    'de:admin.flows.runs.table.status',
    'de:admin.flows.table.flow',
    'de:admin.flows.table.status',
    'de:admin.flows.targets.emailPlaceholder',
    'de:admin.flows.title',
    'de:admin.hub.cards.apps.title',
    'de:admin.hub.cards.flows.title',
    'de:admin.hub.cards.navigation.title',
    'de:admin.navigation.pinMobile',
    'de:admin.navigation.title',
    'de:admin.pageLayouts.blocks.text',
    'de:admin.pageLayouts.columns.route',
    'de:admin.pageLayouts.columns.status',
    'de:admin.pageLayouts.status.filter',
    'de:admin.permissions.groups.apps',
    'de:admin.permissions.groups.compliance',
    'de:admin.permissions.groups.data',
    'de:admin.permissions.groups.flows',
    'de:admin.permissions.groups.insights',
    'de:admin.roles.drawer.keyPlaceholder',
    'de:admin.scripts.drawer.cronHint',
    'de:admin.scripts.drawer.runStatus.ok',
    'de:admin.scripts.drawer.trigger',
    'de:admin.scripts.table.status',
    'de:admin.scripts.table.trigger',
    'de:admin.scripts.tabs.code',
    'de:admin.scripts.triggerFilter',
    'de:admin.settings.documentKinds.journal',
    'de:admin.settings.fiscal.frameworkAsc740',
    'de:admin.settings.fiscal.frameworkIas12',
    'de:admin.settings.fiscal.range',
    'de:admin.settings.fiscal.reportingFrameworkIfrs',
    'de:admin.settings.months.april',
    'de:admin.settings.months.august',
    'de:admin.settings.months.november',
    'de:admin.settings.months.september',
    'de:admin.settings.organization.countryHint',
    'de:admin.settings.organization.displayNamePlaceholder',
    'de:admin.settings.organization.legalNamePlaceholder',
    'de:admin.setup.agents.activity.packColumn',
    'de:admin.setup.agents.activity.statusColumn',
    'de:admin.setup.agents.overview.columns.pack',
    'de:admin.setup.agents.overview.columns.status',
    'de:admin.setup.drawer.tabs.details',
    'de:admin.setup.entities.overhead-model.application.status',
    'de:admin.setup.entities.overhead-model.lifecycle.modes.live',
    'de:admin.setup.entities.sftp.title',
    'de:admin.setup.fieldHelp.expiryWarningDaysHint',
    'de:admin.setup.fieldHelp.graceDaysHint',
    // HR-5: genuine German prose whose only English-looking words are the
    // JSON accrual-kind/field identifiers that must stay exact (kind,
    // per_year, hours, none, per_period, periods_per_year, unlimited).
    'de:admin.setup.fieldHelp.leaveAccrualRule',
    'de:admin.setup.fields.basis',
    'de:admin.setup.fields.code',
    'de:admin.setup.fields.dimension',
    'de:admin.setup.fields.extensionKey',
    'de:admin.setup.fields.maxBalance',
    'de:admin.setup.fields.name',
    'de:admin.setup.fields.planId',
    'de:admin.setup.fields.regime',
    'de:admin.setup.fields.region',
    'de:admin.setup.fields.segmentId',
    'de:admin.setup.fxProvider.providers.bank_of_canada',
    'de:admin.setup.fxProvider.providers.open_exchange_rates',
    'de:admin.setup.groups.compliance',
    'de:admin.setup.laborCosting.billing.adjustmentCode',
    'de:admin.setup.laborCosting.billing.adjustmentName',
    'de:admin.setup.laborCosting.billing.categories.minimum',
    'de:admin.setup.laborCosting.billing.status',
    'de:admin.setup.laborCosting.components.name',
    'de:admin.setup.laborCosting.rates.basis',
    'de:admin.setup.laborCosting.rates.status',
    'de:admin.setup.laborCosting.wizard.ratePlaceholder',
    'de:admin.setup.options.costingMethod.fifo',
    'de:admin.setup.options.governmentFormat.api',
    'de:admin.setup.options.holidayJurisdiction.caAb',
    'de:admin.setup.options.holidayJurisdiction.caBc',
    'de:admin.setup.options.holidayJurisdiction.caOn',
    'de:admin.setup.options.holidayJurisdiction.caSk',
    'de:admin.setup.options.informationReturnForm.misc',
    'de:admin.setup.options.informationReturnForm.nec',
    'de:admin.setup.options.informationReturnForm.t4a',
    'de:admin.setup.options.jurisdictionLevel.county',
    'de:admin.setup.options.macrsSystem.ads',
    'de:admin.setup.options.macrsSystem.gds',
    'de:admin.setup.options.overheadMethod.live',
    'de:admin.setup.options.overheadMethod.standard',
    'de:admin.setup.options.payTaxTreatment.pensionF',
    'de:admin.setup.options.stockLocationKind.transit',
    'de:admin.setup.options.stockLocationKind.zone',
    'de:admin.setup.options.taxType.gst',
    'de:admin.setup.options.taxType.hst',
    'de:admin.setup.options.taxType.pst',
    'de:admin.setup.options.taxType.qst',
    'de:admin.setup.paymentOperations.columns.code',
    'de:admin.setup.paymentOperations.columns.format',
    'de:admin.setup.paymentOperations.columns.name',
    'de:admin.setup.paymentOperations.columns.status',
    'de:admin.setup.paymentOperations.fields.code',
    'de:admin.setup.paymentOperations.fields.name',
    'de:admin.setup.paymentOperations.fields.sftpServer',
    'de:admin.setup.paymentOperations.fields.status',
    'de:admin.setup.paymentOperations.rails.positive_pay',
    'de:admin.setup.paymentOperations.schemes.nacha',
    'de:admin.setup.paymentOperations.schemes.sepa_b2b',
    'de:admin.setup.paymentOperations.schemes.sepa_core',
    'de:admin.setup.paymentOperations.secretFields.transit',
    'de:admin.setup.paymentProviders.ruleName',
    'de:admin.setup.taxLibrary.status',
    'de:admin.setup.wizard.company.legalName',
    'de:admin.setup.wizard.company.namePlaceholder',
    'de:admin.setup.wizard.industries.it_software_saas.title',
    'de:admin.setup.wizard.launch.taxQuestion',
    'de:admin.users.statusFilter',
    'ja:admin.ai.agents.units.percent',
    'ja:admin.backupsManager.table.sha256',
    'ja:admin.buildHub.groups.api',
    'ja:admin.customFields.drawer.keyPlaceholder',
    'ja:admin.features.apiAccess.title',
    'ja:admin.features.crm.title',
    'ja:admin.flows.targets.emailPlaceholder',
    'ja:admin.hub.cards.ai.title',
    'ja:admin.roles.drawer.keyPlaceholder',
    'ja:admin.settings.fiscal.range',
    'ja:admin.settings.fiscal.reportingFrameworkIfrs',
    'ja:admin.settings.fiscal.reportingFrameworkUsGaap',
    'ja:admin.settings.organization.displayNamePlaceholder',
    'ja:admin.settings.organization.legalNamePlaceholder',
    'ja:admin.setup.entities.sftp.title',
    'ja:admin.setup.fieldHelp.expiryWarningDaysHint',
    'ja:admin.setup.fieldHelp.graceDaysHint',
    'ja:admin.setup.fxProvider.providers.bank_of_canada',
    'ja:admin.setup.fxProvider.providers.ecb',
    'ja:admin.setup.fxProvider.providers.open_exchange_rates',
    'ja:admin.setup.laborCosting.wizard.ratePlaceholder',
    'ja:admin.setup.options.costingMethod.fifo',
    'ja:admin.setup.options.informationReturnForm.misc',
    'ja:admin.setup.options.informationReturnForm.nec',
    'ja:admin.setup.options.informationReturnForm.t4a',
    'ja:admin.setup.options.macrsSystem.ads',
    'ja:admin.setup.options.macrsSystem.gds',
    'ja:admin.setup.options.taxType.gst',
    'ja:admin.setup.options.taxType.hst',
    'ja:admin.setup.options.taxType.pst',
    'ja:admin.setup.options.taxType.qst',
    'ja:admin.setup.paymentOperations.rails.positive_pay',
    'ja:admin.setup.paymentOperations.schemes.nacha',
    'ja:admin.setup.paymentOperations.schemes.sepa_b2b',
    'ja:admin.setup.paymentOperations.schemes.sepa_core',
    'ja:admin.setup.paymentProviders.webhookUrl',
    'ja:admin.setup.wizard.company.namePlaceholder',
    // HR-20: Polygon and Radius (m) are the ordinary German terms, not
    // untranslated English.
    'de:admin.setup.fields.polygon',
    'de:admin.setup.fields.radiusM',
    'de:admin.setup.options.geofenceKind.polygon',
  ])
  // HR-17: count and hash recomputed over the sorted key inventory for the
  // 19 continuous-performance keys; de/ja completeness asserted per-key below.
  // HR-17 + HR-18: count and hash recomputed over the sorted key inventory
  // for the continuous-performance and recruiting-depth keys; de/ja completeness
  // asserted per-key below.
  // m17_hrm_ui/F5: 4050 + rehash for the 3 HR permission labels and the 6 pipeline-entity keys, translated
  // in all 7 locales.
  // m17_hrm_ui/F5-followup: 4062 + rehash for the 12 rehomed-entity keys.
  // m23_insights_autosave/F1: 4069 + rehash for the 6 flow-builder keyboard
  // connect keys (builder.inspector.connect*), translated in all 7 locales.
  // CTRL-01 + UX-19 + UX-17: 4084 + rehash.
  // TZ1: 4091 + rehash for the 5 business-time-zone keys, translated in
  // all 7 locales.
  // g31/IN11: 4091 + rehash for the 2 stock-count independent-review keys,
  // translated in all 7 locales.
  // +2 from main (recognition-rule policy keys): 4093.
  const ADMIN_I2_SOURCE_COUNT = 4093
  const ADMIN_I2_SOURCE_HASH = '6e52afc28e79f219053f57784e565a52dd812d79d6f82494326c614ca01461d0'
  const source = flattenCatalog('en')
  const sourceKeys = [...source.keys()]
    .filter((key) => key === 'admin' || key.startsWith('admin.'))
    .sort()
  assert.equal(
    sourceKeys.length,
    ADMIN_I2_SOURCE_COUNT,
    'admin English source inventory changed; translate the new keys in de/ja and re-pin',
  )
  assert.equal(
    sha256(sourceKeys.join('\n')),
    ADMIN_I2_SOURCE_HASH,
    'admin English source inventory changed; translate the new keys in de/ja and re-pin',
  )
  for (const locale of ['de', 'ja'] as const) {
    const catalog = flattenCatalog(locale)
    const missing = sourceKeys.filter((key) => !catalog.has(key))
    const copiedEnglish = sourceKeys.filter(
      (key) => catalog.get(key) === source.get(key) && !ADMIN_I2_COGNATES.has(`${locale}:${key}`),
    )
    const prose = (value: string): string => value.replace(/\{[^}]*\}/g, ' ')
    const staleEnglish = sourceKeys.filter((key) => {
      const sourceValue = source.get(key)
      const localizedValue = catalog.get(key)
      return (
        sourceValue !== undefined &&
        localizedValue !== undefined &&
        isAsciiEnglishCopy(prose(sourceValue), prose(localizedValue)) &&
        !ADMIN_I2_COGNATES.has(`${locale}:${key}`)
      )
    })
    const placeholderDrift = sourceKeys.filter((key) => {
      // Like the payroll-chrome pin, but a `{Word}` opened right after an
      // arm selector (`=0 {Einrichten}`, `one {Ereignisdetails}`) is the
      // arm's prose, not a placeholder — counting it would force every
      // locale to echo English word breaks.
      const tokens = (value: string): Set<string> => {
        const found = new Set<string>()
        const pattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)(?=[,}])/g
        let match: RegExpExecArray | null
        while ((match = pattern.exec(value)) !== null) {
          const before = value.slice(0, match.index)
          if (/(?:^|[\s{])(?:=\d+|one|other|few|many|zero|male|female)\s$/.test(before)) continue
          found.add(match[0])
        }
        return found
      }
      const expected = tokens(source.get(key) ?? '')
      const actual = tokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(missing, [], `${locale} is missing admin translations`)
    assert.deepEqual(
      copiedEnglish,
      [],
      `${locale} contains source-English admin copy that would be counted as translated`,
    )
    assert.deepEqual(
      staleEnglish,
      [],
      `${locale} contains stale ASCII-only English admin prose`,
    )
    assert.deepEqual(
      placeholderDrift,
      [],
      `${locale} admin translations drop or rename ICU placeholders`,
    )
  }
})

test('payroll copy ships translated in ja, zh and pt-BR', () => {
  // i7: the payroll namespace (1074 keys) rendered English in ja/zh/pt-BR
  // (only 226 keys translated each). Every leaf must exist, keep its ICU
  // placeholders and plural/select arms, and differ from English except for
  // reviewed identicals — placeholder-only templates, statutory codes and
  // genuine cognates — pinned to the exact term.
  const I7_IDENTICAL_BY_FACT = new Set([
    // HR-21: "Info" is the ordinary word in Portuguese for the lowest
    // severity band, exactly as in English. Translating it to
    // "Informacao" would make the three severity chips different
    // lengths for no gain in meaning.
    'pt-BR:payroll.anomalies.severity.info|Info',
    'ja:payroll.filings.run.title|{label}',
    'ja:payroll.filings.slip.description|{label} · {year}',
    'ja:payroll.profiles.fields.sin|SIN / SSN',
    'ja:payroll.register.cppFica|CPP / FICA',
    'ja:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
    'ja:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
    'ja:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
    'ja:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
    'ja:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
    'ja:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
    'zh:payroll.filings.run.title|{label}',
    'zh:payroll.filings.slip.description|{label} · {year}',
    'zh:payroll.profiles.fields.sin|SIN / SSN',
    'zh:payroll.register.cppFica|CPP / FICA',
    'zh:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
    'zh:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
    'zh:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
    'zh:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
    'zh:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
    'zh:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
    'pt-BR:payroll.columns.status|Status',
    'pt-BR:payroll.entitlements.hoursSuffix|h',
    'pt-BR:payroll.filings.run.title|{label}',
    'pt-BR:payroll.filings.slip.description|{label} · {year}',
    'pt-BR:payroll.paymentMethod.cheque|Cheque',
    'pt-BR:payroll.profiles.columns.status|Status',
    'pt-BR:payroll.profiles.fields.sin|SIN / SSN',
    'pt-BR:payroll.profiles.paymentMethod.cheque|Cheque',
    'pt-BR:payroll.register.cppFica|CPP / FICA',
    'pt-BR:payroll.settingsPage.derivedPreview.total|Total',
    'pt-BR:payroll.settingsPage.workSchedules.columns.status|Status',
    'pt-BR:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
    'pt-BR:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
    'pt-BR:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
    'pt-BR:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
    'pt-BR:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
    'pt-BR:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
    'pt-BR:payroll.workSchedules.columns.status|Status',
  ])
  const I7_SOURCE = flattenCatalog('en')
  const I7_WANTED = [...I7_SOURCE.keys()].filter((key) => key.startsWith('payroll.'))
  // 1142: the ten-pack inventory plus Singapore, Japan, Poland and Brazil,
  // which landed together. Four shards each re-pinned this number against
  // their own base, so the merge saw four competing values — re-pin to the
  // measured count rather than to any one shard's arithmetic.
  assert.equal(I7_WANTED.length, 1221, 'payroll source inventory changed; translate the new keys in ja/zh/pt-BR and re-pin')
  for (const key of I7_WANTED) {
    const english = I7_SOURCE.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  const I7_tokens = (value: string): Set<string> =>
    new Set(value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I7_arms = (value: string): string[] => value.match(/, +(plural|select)/g) ?? []
  for (const locale of ['ja', 'zh', 'pt-BR']) {
    const I7_catalog = flattenCatalog(locale)
    for (const key of I7_WANTED) {
      const value = I7_catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...I7_IDENTICAL_BY_FACT].find((entry) => entry.startsWith(`${locale}:${key}|`))
      if (identical) {
        assert.equal(value, identical.split('|')[1], `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, I7_SOURCE.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const I7_drift = I7_WANTED.filter((key) => {
      const expected = I7_tokens(I7_SOURCE.get(key) ?? '')
      const actual = I7_tokens(I7_catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(I7_drift, [], `${locale} payroll translations drop or rename ICU placeholders`)
    const I7_armsDrift = I7_WANTED.filter((key) => {
      const expected = I7_arms(I7_SOURCE.get(key) ?? '').join(',')
      const actual = I7_arms(I7_catalog.get(key) ?? '').join(',')
      return expected !== actual
    })
    assert.deepEqual(I7_armsDrift, [], `${locale} payroll translations drop ICU plural/select arms`)
  }
})

const I6_PAYROLL_IDENTICAL_BY_FACT = new Set([
  // HR-21 begin: payroll anomaly chips. "Status" and "Info" are the
  // German and French/Spanish words, not untranslated English -- the
  // block severity beside them IS translated (de: Blockierend), which
  // is how you can tell these four were decided rather than skipped.
  'de:payroll.anomalies.statusLabel|Status',
  'de:payroll.anomalies.columns.status|Status',
  'de:payroll.anomalies.severity.info|Info',
  'es:payroll.anomalies.severity.info|Info',
  'fr:payroll.anomalies.severity.info|Info',
  // HR-21 end
  'fr:payroll.columns.net|Net',
  'fr:payroll.entitlements.hoursSuffix|h',
  'fr:payroll.entitlements.movementDate|Date',
  'fr:payroll.entitlements.movementKind|Type',
  'fr:payroll.entitlements.source|Source',
  'fr:payroll.filings.lifecycle.correction|Correction',
  'fr:payroll.filings.run.title|{label}',
  'fr:payroll.filings.slip.description|{label} · {year}',
  'fr:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
  'fr:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
  'fr:payroll.parallelRun.exact|exact',
  'fr:payroll.parallelRun.tiles.net|Net',
  'fr:payroll.profiles.columns.province|Province',
  'fr:payroll.profiles.country.CA|Canada',
  'fr:payroll.settingsPage.derivedPreview.total|Total',
  'fr:payroll.settingsPage.holidayCalendar.citation|Source',
  'fr:payroll.settingsPage.holidayCalendar.source|Source',
  'fr:payroll.wizard.gl.description|Description',
  'fr:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
  'fr:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
  'fr:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
  'fr:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
  'fr:payroll.wizard.review.varianceColumn|Δ net',
  'es:payroll.entitlements.hoursSuffix|h',
  'es:payroll.entitlements.plan|Plan',
  'es:payroll.filings.run.title|{label}',
  'es:payroll.filings.slip.description|{label} · {year}',
  'es:payroll.paymentMethod.cheque|Cheque',
  'es:payroll.profiles.fields.sin|SIN / SSN',
  'es:payroll.profiles.paymentMethod.cheque|Cheque',
  'es:payroll.register.cppFica|CPP / FICA',
  'es:payroll.settingsPage.derivedPreview.total|Total',
  'es:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
  'es:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
  'es:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
  'es:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
  'es:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
  'es:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
  'de:payroll.columns.status|Status',
  'de:payroll.entitlements.hoursSuffix|h',
  'de:payroll.entitlements.plan|Plan',
  'de:payroll.filings.run.title|{label}',
  'de:payroll.filings.slip.description|{label} · {year}',
  'de:payroll.profiles.columns.status|Status',
  'de:payroll.profiles.fields.sin|SIN / SSN',
  'de:payroll.register.cppFica|CPP / FICA',
  'de:payroll.settingsPage.rates.columns.region|Region',
  'de:payroll.settingsPage.workSchedules.columns.status|Status',
  'de:payroll.settingsPage.workSchedules.fields.name|Name',
  'de:payroll.setupWizard.schedule.name|Name',
  'de:payroll.wizard.readiness.codes.setup.statutoryRate|{detail}',
  'de:payroll.wizard.readiness.codes.setup.taxYear|{detail}',
  'de:payroll.wizard.readiness.codes.statutory.rateUnconfigured|{detail}',
  'de:payroll.wizard.readiness.codes.statutory.taxYear|{detail}',
  'de:payroll.wizard.readiness.codes.pack.notPayable|{detail}',
  'de:payroll.wizard.readiness.codes.employee.missingFact|{detail}',
  'de:payroll.workSchedules.columns.status|Status',
  'de:payroll.workSchedules.fields.name|Name',
])

test('I6 payroll copy ships translated in fr, es and de', () => {
  // F-i6-001: 848 payroll leaves per locale (settingsPage, wizard, profiles,
  // parallelRun, filings, setupWizard, workSchedules, openingBalances,
  // entitlements, separations, paymentMethod, links, readiness, retro)
  // existed only in en — fr/es/de rendered English inside otherwise
  // translated payroll screens. Every leaf must exist, keep its ICU
  // placeholders and plural/select arms, and differ from English except
  // for reviewed cognates, pinned to the exact term.
  const I6_source = flattenCatalog('en')
  const I6_wanted = [...I6_source.keys()].filter((I6_key) => I6_key.startsWith('payroll.'))
  assert.equal(I6_wanted.length, 1221, 'payroll source inventory changed; translate the new keys in fr/es/de and re-pin')
  const I6_tokens = (I6_value: string): Set<string> =>
    new Set(I6_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I6_arms = (I6_value: string): string[] => I6_value.match(/, +(plural|select)/g) ?? []
  for (const I6_locale of ['fr', 'es', 'de']) {
    const I6_catalog = flattenCatalog(I6_locale)
    for (const I6_key of I6_wanted) {
      const I6_value = I6_catalog.get(I6_key)
      assert.ok(I6_value && I6_value.trim(), `${I6_locale} is missing ${I6_key}`)
      const I6_identical = [...I6_PAYROLL_IDENTICAL_BY_FACT].find((I6_entry) =>
        I6_entry.startsWith(`${I6_locale}:${I6_key}|`),
      )
      if (I6_identical) {
        assert.equal(I6_value, I6_identical.split('|')[1], `${I6_locale}:${I6_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I6_value, I6_source.get(I6_key), `${I6_locale} must not copy English ${I6_key}`)
      }
    }
    const I6_drift = I6_wanted.filter((I6_key) => {
      const I6_expected = I6_tokens(I6_source.get(I6_key) ?? '')
      const I6_actual = I6_tokens(I6_catalog.get(I6_key) ?? '')
      return I6_expected.size !== I6_actual.size || [...I6_expected].some((I6_token) => !I6_actual.has(I6_token))
    })
    assert.deepEqual(I6_drift, [], `${I6_locale} payroll translations drop or rename ICU placeholders`)
    const I6_armsDrift = I6_wanted.filter((I6_key) => {
      const I6_expected = I6_arms(I6_source.get(I6_key) ?? '').join(',')
      const I6_actual = I6_arms(I6_catalog.get(I6_key) ?? '').join(',')
      return I6_expected !== I6_actual
    })
    assert.deepEqual(I6_armsDrift, [], `${I6_locale} payroll translations drop ICU plural/select arms`)
  }
})

test('change-request approval rows carry a translated kind label in every locale', () => {
  // An hrm_employment_change_request hire approval showed a generic kind
  // with an opaque id and a blank party while offering Approve and
  // Reject. Every locale needs the kinds label or the row falls back to
  // the raw code.
  const key = 'approvals.kinds.hrm_employment_change_request'
  const source = flattenCatalog('en')
  assert.ok(source.get(key)?.trim(), `English source is missing ${key}`)
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const value = flattenCatalog(locale).get(key)
    assert.ok(value && value.trim(), `${locale} is missing ${key}`)
    assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
  }
})

test('inbox source-unavailable notices ship translated in every locale', () => {
  // OM-10: one refusing or failing source names itself beside the surviving
  // rows through this key (the area label inside {source}, the source's own
  // message inside {reason}). An absent key falls back to English inside an
  // otherwise translated inbox — the same silent shape as the v0.1.0-alpha.22
  // unregistered-namespace defect. The pinned key list is the per-area count:
  // adding notice copy here means translating it in all seven locales.
  const keys = ['inbox.sourceUnavailable'] as const
  const source = flattenCatalog('en')
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      for (const token of ['{source}', '{reason}']) {
        assert.ok(value.includes(token), `${locale} ${key} must keep the ${token} interpolation`)
      }
    }
  }
})

test('budget approval rows carry a translated kind label in every locale', () => {
  // The approvals inbox renders pending budgets with a kinds label
  // (F-t13-005); without one the row falls back to the raw
  // 'budget_scenario' code, the same defect class as the close publish
  // list. French keeps 'budget' — the French word, like the documented
  // 'Scripts' identical-term exemption.
  const key = 'approvals.kinds.budget_scenario'
  const source = flattenCatalog('en')
  assert.ok(source.get(key)?.trim(), `English source is missing ${key}`)
  for (const locale of locales.filter((candidate) => candidate !== 'en').sort()) {
    const value = flattenCatalog(locale).get(key)
    assert.ok(value && value.trim(), `${locale} is missing ${key}`)
    if (locale !== 'fr') {
      assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
    }
  }
})

// F-i8-001: the 286 apps leaves per locale (drawer, management, editor,
// definitions, screens, create, plus library/actions additions) existed only
// in en — every non-English locale rendered English inside otherwise
// translated apps screens. Every leaf must exist, keep its ICU placeholders
// and plural/select arms, and differ from English except for reviewed
// cognates and code/example keeps, pinned to the exact term.
const I8_APPS_IDENTICAL_BY_FACT = new Set([
  'fr:apps.version|Version {version}',
  'fr:apps.actions.documentation|Documentation',
  'fr:apps.admin.columns.version|Version',
  'es:apps.admin.columns.endpoints|Endpoints',
  'de:apps.title|Apps',
  'de:apps.version|Version {version}',
  'de:apps.admin.title|Apps',
  'de:apps.admin.status|Status',
  'de:apps.admin.columns.name|Name',
  'de:apps.admin.columns.version|Version',
  'de:apps.admin.columns.status|Status',
  'pt-BR:apps.title|Apps',
  'pt-BR:apps.admin.title|Apps',
  'pt-BR:apps.admin.status|Status',
  'pt-BR:apps.admin.columns.endpoints|Endpoints',
  'pt-BR:apps.admin.columns.status|Status',
  'fr:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'fr:apps.drawer.labels.description|Description',
  'fr:apps.drawer.labels.navigation|Navigation',
  'fr:apps.drawer.endpointNamePlaceholder|name',
  'fr:apps.editor.overview|Configuration',
  'fr:apps.editor.sections.actions|Actions',
  'fr:apps.editor.version|Version',
  'fr:apps.editor.description|Description',
  'fr:apps.editor.renderer|Interface',
  'fr:apps.management.versions|Versions',
  'fr:apps.management.version|Version',
  'fr:apps.management.actions|Actions',
  'fr:apps.management.active|Active',
  'fr:apps.management.page|Page {page}',
  'fr:apps.management.fields.version|Version',
  'fr:apps.management.fields.endpoint|Action',
  'fr:apps.screens.page|Page',
  'es:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'es:apps.drawer.endpointNamePlaceholder|name',
  'es:apps.editor.sections.general|General',
  'es:apps.management.fields.error_message|Error',
  'de:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'de:apps.drawer.labels.name|Name',
  'de:apps.drawer.labels.status|Status',
  'de:apps.drawer.labels.navigation|Navigation',
  'de:apps.drawer.endpointNamePlaceholder|name',
  'de:apps.editor.sections.screens|Screens',
  'de:apps.editor.version|Version',
  'de:apps.management.version|Version',
  'de:apps.management.status|Status',
  'de:apps.management.fields.version|Version',
  'de:apps.management.fields.status|Status',
  'de:apps.management.fields.namespace|Namespace',
  'ja:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'ja:apps.drawer.endpointNamePlaceholder|name',
  'zh:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'zh:apps.drawer.endpointNamePlaceholder|name',
  'pt-BR:apps.drawer.toolbar.newAppPromptPlaceholder|Expense Insights',
  'pt-BR:apps.drawer.labels.status|Status',
  'pt-BR:apps.drawer.endpointNamePlaceholder|name',
  'pt-BR:apps.editor.renderer|Interface',
  'pt-BR:apps.management.status|Status',
  'pt-BR:apps.management.fields.status|Status',
  'pt-BR:apps.management.fields.namespace|Namespace',
])

test('I8 apps copy ships translated in fr, es, de, ja, zh and pt-BR', () => {
  const I8_source = flattenCatalog('en')
  const I8_wanted = [...I8_source.keys()].filter((I8_key) => I8_key.startsWith('apps.'))
  assert.equal(I8_wanted.length, 334, 'apps source inventory changed; translate the new keys in fr/es/de/ja/zh/pt-BR and re-pin')
  const I8_tokens = (I8_value: string): Set<string> =>
    new Set(I8_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I8_arms = (I8_value: string): string[] => I8_value.match(/, +(plural|select)/g) ?? []
  for (const I8_locale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I8_catalog = flattenCatalog(I8_locale)
    for (const I8_key of I8_wanted) {
      const I8_value = I8_catalog.get(I8_key)
      assert.ok(I8_value && I8_value.trim(), `${I8_locale} is missing ${I8_key}`)
      const I8_identical = [...I8_APPS_IDENTICAL_BY_FACT].find((I8_entry) =>
        I8_entry.startsWith(`${I8_locale}:${I8_key}|`),
      )
      if (I8_identical) {
        assert.equal(I8_value, I8_identical.split('|')[1], `${I8_locale}:${I8_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I8_value, I8_source.get(I8_key), `${I8_locale} must not copy English ${I8_key}`)
      }
    }
    const I8_drift = I8_wanted.filter((I8_key) => {
      const I8_expected = I8_tokens(I8_source.get(I8_key) ?? '')
      const I8_actual = I8_tokens(I8_catalog.get(I8_key) ?? '')
      return I8_expected.size !== I8_actual.size || [...I8_expected].some((I8_token) => !I8_actual.has(I8_token))
    })
    assert.deepEqual(I8_drift, [], `${I8_locale} apps translations drop or rename ICU placeholders`)
    const I8_armsDrift = I8_wanted.filter((I8_key) => {
      const I8_expected = I8_arms(I8_source.get(I8_key) ?? '').join(',')
      const I8_actual = I8_arms(I8_catalog.get(I8_key) ?? '').join(',')
      return I8_expected !== I8_actual
    })
    assert.deepEqual(I8_armsDrift, [], `${I8_locale} apps translations drop ICU plural/select arms`)
  }
})


const I11_IDENTICAL_BY_FACT = new Set([
  'fr:close.actions.documentation|Documentation',
  'fr:close.modules.gl|GL',
  'fr:close.postingPeriods.document|Document',
  'fr:close.postingPeriods.previewTitle|{count, plural, one {# document} other {# documents}}',
  'fr:close.runDescription|{book} · {blueprint} v{version}',
  'fr:close.setup.automationConfig.body|Message',
  'fr:close.setup.conditions.readinessHint|0–100.',
  'fr:close.setup.delivery.formats.both|PDF + Excel',
  'fr:close.setup.delivery.formats.pdf|PDF',
  'fr:close.setup.delivery.formats.xlsx|Excel',
  'fr:close.setup.fields.action|Action',
  'fr:close.setup.fields.cadence|Cadence',
  'fr:close.setup.fields.conditions|Conditions',
  'fr:close.setup.fields.configuration|Configuration',
  'fr:close.setup.fields.description|Description',
  'fr:close.setup.modules.gl|GL',
  'fr:close.setup.policyTypes.exception|Exception',
  'fr:close.setup.taskTypes.action|Action',
  'fr:close.setup.taskTypes.journal|Journal',
  'fr:close.setup.taskTypes.publish|Publication',
  'fr:close.table.action|Action',
  'fr:close.table.rangeValue|{start} → {end}',
  'fr:continuous-close.agents.finance|Finance',
  'fr:continuous-close.fields.budget|Budget',
  'fr:continuous-close.fields.points|points',
  'fr:continuous-close.filters.agent|Agent',
  'fr:continuous-close.narrative.downloadPdf|PDF',
  'fr:continuous-close.narrative.sourceLabel|Source',
  'fr:continuous-close.severity.info|Information',
  'fr:continuous-close.table.agent|Agent',
  'es:close.runDescription|{book} · {blueprint} v{version}',
  'es:close.setup.completionModes.manual|Manual',
  'es:close.setup.conditions.readinessHint|0–100.',
  'es:close.setup.delivery.formats.both|PDF + Excel',
  'es:close.setup.delivery.formats.pdf|PDF',
  'es:close.setup.delivery.formats.xlsx|Excel',
  'es:close.severity.error|Error',
  'es:close.table.rangeValue|{start} → {end}',
  'es:continuous-close.narrative.downloadPdf|PDF',
  'de:close.filters.status|Status',
  'de:close.postingPeriods.status|Status',
  'de:close.runDescription|{book} · {blueprint} v{version}',
  'de:close.setup.automationConfig.gate|Gate',
  'de:close.setup.conditions.readinessHint|0–100.',
  'de:close.setup.delivery.formats.both|PDF + Excel',
  'de:close.setup.delivery.formats.pdf|PDF',
  'de:close.setup.delivery.formats.xlsx|Excel',
  'de:close.setup.fields.gate|Gate',
  'de:close.setup.fields.name|Name',
  'de:close.setup.table.status|Status',
  'de:close.setup.taskTypes.journal|Journal',
  'de:close.severity.info|Info',
  'de:close.table.rangeValue|{start} → {end}',
  'de:close.table.status|Status',
  'de:close.timeline.system|System',
  'de:continuous-close.fields.budget|Budget',
  'de:continuous-close.filters.agent|Agent',
  'de:continuous-close.narrative.downloadPdf|PDF',
  'de:continuous-close.severity.info|Information',
  'de:continuous-close.table.agent|Agent',
  'ja:close.runDescription|{book} · {blueprint} v{version}',
  'ja:close.setup.delivery.formats.both|PDF + Excel',
  'ja:close.setup.delivery.formats.pdf|PDF',
  'ja:close.setup.delivery.formats.xlsx|Excel',
  'ja:close.table.rangeValue|{start} → {end}',
  'ja:continuous-close.narrative.downloadPdf|PDF',
  'zh:close.filters.fyOption|FY {year}',
  'zh:close.runDescription|{book} · {blueprint} v{version}',
  'zh:close.setup.delivery.formats.both|PDF + Excel',
  'zh:close.setup.delivery.formats.pdf|PDF',
  'zh:close.setup.delivery.formats.xlsx|Excel',
  'zh:close.table.rangeValue|{start} → {end}',
  'zh:continuous-close.narrative.downloadPdf|PDF',
  'pt-BR:close.filters.status|Status',
  'pt-BR:close.postingPeriods.status|Status',
  'pt-BR:close.runDescription|{book} · {blueprint} v{version}',
  'pt-BR:close.scope.blueprint|Blueprint',
  'pt-BR:close.setup.automationConfig.gate|Gate',
  'pt-BR:close.setup.completionModes.manual|Manual',
  'pt-BR:close.setup.conditions.readinessHint|0–100.',
  'pt-BR:close.setup.delivery.formats.both|PDF + Excel',
  'pt-BR:close.setup.delivery.formats.pdf|PDF',
  'pt-BR:close.setup.delivery.formats.xlsx|Excel',
  'pt-BR:close.setup.fields.gate|Gate',
  'pt-BR:close.setup.table.status|Status',
  'pt-BR:close.setup.tabs.blueprints|Blueprints',
  'pt-BR:close.setup.workstreams.intercompany|Intercompany',
  'pt-BR:close.table.rangeValue|{start} → {end}',
  'pt-BR:close.table.status|Status',
  'pt-BR:close.workstreams.intercompany|Intercompany',
  'pt-BR:continuous-close.narrative.downloadPdf|PDF',
])

test('I11 close and continuous-close copy ships translated in every locale', () => {
  // F-i11-001: 141 close leaves per locale in fr/es plus the setup tail
  // (policyRules, conditions, automationConfig, subjectRefs, reportGroups,
  // delivery, kv, reportParams), the postingPeriods section in
  // de/ja/zh/pt-BR, and the continuous-close findings/evidence/agents/metrics
  // tail in de/ja/zh/pt-BR existed only in en — those locales rendered
  // English inside otherwise translated close screens. Every leaf must exist,
  // keep its ICU placeholders and plural/select arms, and differ from English
  // except for reviewed cognates, codes and placeholder-only skeletons,
  // pinned to the exact term above.
  const I11_source = flattenCatalog('en')
  const I11_closeWanted = [...I11_source.keys()].filter((I11_key) => I11_key.startsWith('close.'))
  const I11_ccWanted = [...I11_source.keys()].filter((I11_key) => I11_key.startsWith('continuous-close.'))
  assert.equal(I11_closeWanted.length, 598, 'close source inventory changed; translate the new keys in every locale and re-pin')
  assert.equal(I11_ccWanted.length, 222, 'continuous-close source inventory changed; translate the new keys in every locale and re-pin')
  const I11_tokens = (I11_value: string): Set<string> =>
    new Set(I11_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I11_arms = (I11_value: string): string[] => I11_value.match(/, +(plural|select)/g) ?? []
  for (const I11_locale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I11_catalog = flattenCatalog(I11_locale)
    for (const I11_key of [...I11_closeWanted, ...I11_ccWanted]) {
      const I11_value = I11_catalog.get(I11_key)
      assert.ok(I11_value && I11_value.trim(), `${I11_locale} is missing ${I11_key}`)
      const I11_identical = [...I11_IDENTICAL_BY_FACT].find((I11_entry) =>
        I11_entry.startsWith(`${I11_locale}:${I11_key}|`),
      )
      if (I11_identical) {
        assert.equal(I11_value, I11_identical.split('|')[1], `${I11_locale}:${I11_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I11_value, I11_source.get(I11_key), `${I11_locale} must not copy English ${I11_key}`)
      }
    }
    const I11_drift = [...I11_closeWanted, ...I11_ccWanted].filter((I11_key) => {
      const I11_expected = I11_tokens(I11_source.get(I11_key) ?? '')
      const I11_actual = I11_tokens(I11_catalog.get(I11_key) ?? '')
      return I11_expected.size !== I11_actual.size || [...I11_expected].some((I11_token) => !I11_actual.has(I11_token))
    })
    assert.deepEqual(I11_drift, [], `${I11_locale} close translations drop or rename ICU placeholders`)
    const I11_armsDrift = [...I11_closeWanted, ...I11_ccWanted].filter((I11_key) => {
      const I11_expected = I11_arms(I11_source.get(I11_key) ?? '').join(',')
      const I11_actual = I11_arms(I11_catalog.get(I11_key) ?? '').join(',')
      return I11_expected !== I11_actual
    })
    assert.deepEqual(I11_armsDrift, [], `${I11_locale} close translations drop ICU plural/select arms`)
  }
})

const I9_BANKING_AP_IDENTICAL_BY_FACT = new Set([
  'fr:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'fr:banking.bankFeeds.client.sftpEndpoint.port|Port',
  'fr:banking.bankFeeds.client.title|Bank Feeds',
  'fr:banking.rules.action|Action',
  'fr:banking.rules.fields.date|Date',
  'fr:banking.rules.fields.description|Description',
  'fr:banking.rules.ops.eq|=',
  'fr:banking.rules.ops.ne|≠',
  'fr:banking.rules.summary.amountRange|{min}–{max}',
  'es:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'es:banking.bankFeeds.client.configure.kindManual|Manual',
  'es:banking.bankFeeds.client.sftpEndpoint.host|Host',
  'es:banking.bankFeeds.client.sftpSecret.hostLabel|host:',
  'es:banking.bankFeeds.client.title|Bank Feeds',
  'es:banking.rules.memoLabel|Memo',
  'es:banking.rules.ops.eq|=',
  'es:banking.rules.ops.ne|≠',
  'es:banking.rules.summary.amountRange|{min}–{max}',
  'es:banking.sftp.endpointTitle|Endpoint',
  'de:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'de:banking.bankFeeds.client.sftpCard.routing|Routing',
  'de:banking.bankFeeds.client.sftpEndpoint.host|Host',
  'de:banking.bankFeeds.client.sftpEndpoint.port|Port',
  'de:banking.bankFeeds.client.sftpEndpoint.status|Status',
  'de:banking.bankFeeds.client.title|Bank Feeds',
  'de:banking.rules.memoLabel|Memo',
  'de:banking.rules.ops.eq|=',
  'de:banking.rules.ops.ne|≠',
  'de:banking.rules.optional|optional',
  'de:banking.rules.summary.amountRange|{min}–{max}',
  'de:banking.sftp.loginsTitle|Logins',
  'ja:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'ja:banking.bankFeeds.client.title|Bank Feeds',
  'ja:banking.rules.ops.eq|=',
  'ja:banking.rules.ops.ne|≠',
  'zh:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'zh:banking.bankFeeds.client.title|Bank Feeds',
  'zh:banking.rules.ops.eq|=',
  'zh:banking.rules.ops.ne|≠',
  'zh:banking.rules.summary.amountRange|{min}–{max}',
  'zh:banking.rules.summary.contains|“{text}”',
  'pt-BR:ap.cockpit.stats.days|{n}d',
  'pt-BR:banking.bankFeeds.client.chooseBank.otherBankHint|Plaid / GoCardless / TrueLayer',
  'pt-BR:banking.bankFeeds.client.configure.kindManual|Manual',
  'pt-BR:banking.bankFeeds.client.sftpCard.login|login',
  'pt-BR:banking.bankFeeds.client.sftpEndpoint.host|Host',
  'pt-BR:banking.bankFeeds.client.sftpEndpoint.status|Status',
  'pt-BR:banking.bankFeeds.client.sftpSecret.hostLabel|host:',
  'pt-BR:banking.bankFeeds.client.title|Bank Feeds',
  'pt-BR:banking.rules.ops.eq|=',
  'pt-BR:banking.rules.ops.ne|≠',
  'pt-BR:banking.rules.summary.amountRange|{min}–{max}',
  'pt-BR:banking.rules.summary.contains|“{text}”',
  'pt-BR:banking.sftp.endpointTitle|Endpoint',
  'pt-BR:banking.sftp.loginsTitle|Logins',
])

test('I9 banking rules/feeds and ap cockpit copy ships translated in every locale', () => {
  // F-i9-001: 274 banking/ap leaves (docStatus, rules builder/scope/split/
  // coding/preview/summary, bank-feed client setup, ap cockpit) plus 23
  // scattered leaves (match actions, drawer card help, sftp endpoint/logins/
  // schedules/tabs, feed tabs) existed only in en — all six locales
  // rendered English inside otherwise translated banking/ap screens.
  // Every leaf must exist, keep its ICU placeholders and plural/select
  // arms, and differ from English except for reviewed cognates, pinned
  // to the exact term.
  const I9_source = flattenCatalog('en')
  const I9_prefixes = [
    'banking.docStatus.',
    'banking.rules.',
    'banking.bankFeeds.client.',
    'ap.cockpit.',
  ]
  const I9_extra = [
    'banking.reconsPage.chooseAccount',
    'banking.match.createRule',
    'banking.match.postAndMatch',
    'banking.match.suggestedBy',
    'banking.drawer.cardAccountHelp',
    'banking.drawer.noCardAccounts',
    'banking.drawer.noCardAccountsCta',
    'banking.sftp.endpointTitle',
    'banking.sftp.endpointHint',
    'banking.sftp.loginsTitle',
    'banking.sftp.connectCommand',
    'banking.sftp.copyField',
    'banking.sftp.copied',
    'banking.sftp.schedules.needsLogin',
    'banking.sftp.schedules.needsAccount',
    'banking.sftp.tabs.endpoint',
    'banking.sftp.tabs.servers',
    'banking.sftp.tabs.schedules',
    'banking.bankFeeds.description',
    'banking.bankFeeds.tabs.connections',
    'banking.bankFeeds.tabs.sftp-endpoint',
    'banking.bankFeeds.tabs.sftp-servers',
    'banking.bankFeeds.tabs.sftp-schedules',
  ]
  const I9_wanted = [...I9_source.keys()].filter(
    (I9_key) => I9_prefixes.some((I9_prefix) => I9_key.startsWith(I9_prefix)) || I9_extra.includes(I9_key),
  )
  assert.equal(I9_wanted.length, 303, 'banking/ap source inventory changed; translate the new keys in every locale and re-pin')
  const I9_tokens = (I9_value: string): Set<string> =>
    new Set(I9_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I9_arms = (I9_value: string): string[] => I9_value.match(/, +(plural|select)/g) ?? []
  for (const I9_locale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I9_catalog = flattenCatalog(I9_locale)
    for (const I9_key of I9_wanted) {
      const I9_value = I9_catalog.get(I9_key)
      assert.ok(I9_value && I9_value.trim(), `${I9_locale} is missing ${I9_key}`)
      const I9_identical = [...I9_BANKING_AP_IDENTICAL_BY_FACT].find((I9_entry) =>
        I9_entry.startsWith(`${I9_locale}:${I9_key}|`),
      )
      if (I9_identical) {
        assert.equal(I9_value, I9_identical.split('|')[1], `${I9_locale}:${I9_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I9_value, I9_source.get(I9_key), `${I9_locale} must not copy English ${I9_key}`)
      }
    }
    const I9_drift = I9_wanted.filter((I9_key) => {
      const I9_expected = I9_tokens(I9_source.get(I9_key) ?? '')
      const I9_actual = I9_tokens(I9_catalog.get(I9_key) ?? '')
      return I9_expected.size !== I9_actual.size || [...I9_expected].some((I9_token) => !I9_actual.has(I9_token))
    })
    assert.deepEqual(I9_drift, [], `${I9_locale} banking/ap translations drop or rename ICU placeholders`)
    const I9_armsDrift = I9_wanted.filter((I9_key) => {
      const I9_expected = I9_arms(I9_source.get(I9_key) ?? '').join(',')
      const I9_actual = I9_arms(I9_catalog.get(I9_key) ?? '').join(',')
      return I9_expected !== I9_actual
    })
    assert.deepEqual(I9_armsDrift, [], `${I9_locale} banking/ap translations drop ICU plural/select arms`)
  }
})

// F-i15-001: compliance.* and fieldTickets.* existed only in en/fr/es —
// de, ja, zh and pt-BR had no catalog files at all (424 keys per locale:
// 286 compliance + 138 fieldTickets) and their index.ts never loaded the
// namespaces, so every compliance/field-ticket screen rendered English.
// Every leaf must exist, keep its {placeholders}, and differ from English
// except for reviewed cognates/codes pinned to the exact term.
const I15_COMPLIANCE_FIELDTICKETS_IDENTICAL_BY_FACT = new Set([
  'de:compliance.filingChannel.iris|IRS IRIS',
  'de:compliance.filingChannel.fire|IRS FIRE',
  'de:compliance.taxClassification.llc|LLC',
  'de:compliance.tinType.ein|EIN',
  'de:compliance.tinType.ssn|SSN',
  'de:compliance.tinType.itin|ITIN',
  'de:compliance.tinType.atin|ATIN',
  'de:compliance.vendors.columns.status|Status',
  'de:compliance.vendors.filters.state|Status',
  'de:compliance.exceptions.window|{from} → {to}',
  'de:compliance.lienWaivers.columns.status|Status',
  'de:compliance.lienWaivers.filters.status|Status',
  'de:compliance.informationReturns.columns.status|Status',
  'de:compliance.informationReturns.columns.tin|TIN',
  'ja:compliance.filingChannel.iris|IRS IRIS',
  'ja:compliance.filingChannel.fire|IRS FIRE',
  'ja:compliance.taxClassification.llc|LLC',
  'ja:compliance.tinType.ein|EIN',
  'ja:compliance.tinType.ssn|SSN',
  'ja:compliance.tinType.itin|ITIN',
  'ja:compliance.tinType.atin|ATIN',
  'ja:compliance.exceptions.window|{from} → {to}',
  'ja:compliance.informationReturns.columns.tin|TIN',
  'zh:compliance.filingChannel.iris|IRS IRIS',
  'zh:compliance.filingChannel.fire|IRS FIRE',
  'zh:compliance.taxClassification.llc|LLC',
  'zh:compliance.tinType.ein|EIN',
  'zh:compliance.tinType.ssn|SSN',
  'zh:compliance.tinType.itin|ITIN',
  'zh:compliance.tinType.atin|ATIN',
  'zh:compliance.exceptions.window|{from} → {to}',
  'zh:compliance.informationReturns.columns.tin|TIN',
  'pt-BR:compliance.filingChannel.iris|IRS IRIS',
  'pt-BR:compliance.filingChannel.fire|IRS FIRE',
  'pt-BR:compliance.taxClassification.llc|LLC',
  'pt-BR:compliance.tinType.ein|EIN',
  'pt-BR:compliance.tinType.ssn|SSN',
  'pt-BR:compliance.tinType.itin|ITIN',
  'pt-BR:compliance.tinType.atin|ATIN',
  'pt-BR:compliance.vendors.columns.status|Status',
  'pt-BR:compliance.vendors.filters.state|Status',
  'pt-BR:compliance.exceptions.window|{from} → {to}',
  'pt-BR:compliance.lienWaivers.columns.status|Status',
  'pt-BR:compliance.lienWaivers.filters.status|Status',
  'pt-BR:compliance.informationReturns.columns.status|Status',
  'pt-BR:compliance.informationReturns.columns.tin|TIN',
  'de:fieldTickets.list.status|Status',
  'de:fieldTickets.editor.tasks.code|Code',
  'de:fieldTickets.editor.pdf|PDF',
  'ja:fieldTickets.editor.pdf|PDF',
  'zh:fieldTickets.editor.pdf|PDF',
  'pt-BR:fieldTickets.list.status|Status',
  'pt-BR:fieldTickets.editor.crew.rowTotal|Total',
  'pt-BR:fieldTickets.editor.lines.item|Item',
  'pt-BR:fieldTickets.editor.pdf|PDF',
])

test('I15 compliance and fieldTickets copy ships translated in de, ja, zh and pt-BR', () => {
  const I15_source = flattenCatalog('en')
  const I15_prefixes = ['compliance.', 'fieldTickets.']
  const I15_wanted = [...I15_source.keys()].filter((I15_key) =>
    I15_prefixes.some((I15_prefix) => I15_key.startsWith(I15_prefix)),
  )
  assert.equal(I15_wanted.length, 431, 'compliance+fieldTickets source inventory changed; translate the new keys in de/ja/zh/pt-BR and re-pin')
  const I15_tokens = (I15_value: string): Set<string> =>
    new Set(I15_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I15_arms = (I15_value: string): string[] => I15_value.match(/, +(plural|select)/g) ?? []
  for (const I15_locale of ['de', 'ja', 'zh', 'pt-BR']) {
    const I15_catalog = flattenCatalog(I15_locale)
    for (const I15_key of I15_wanted) {
      const I15_value = I15_catalog.get(I15_key)
      assert.ok(I15_value && I15_value.trim(), `${I15_locale} is missing ${I15_key}`)
      const I15_identical = [...I15_COMPLIANCE_FIELDTICKETS_IDENTICAL_BY_FACT].find((I15_entry) =>
        I15_entry.startsWith(`${I15_locale}:${I15_key}|`),
      )
      if (I15_identical) {
        assert.equal(I15_value, I15_identical.split('|')[1], `${I15_locale}:${I15_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I15_value, I15_source.get(I15_key), `${I15_locale} must not copy English ${I15_key}`)
      }
    }
    const I15_drift = I15_wanted.filter((I15_key) => {
      const I15_expected = I15_tokens(I15_source.get(I15_key) ?? '')
      const I15_actual = I15_tokens(I15_catalog.get(I15_key) ?? '')
      return I15_expected.size !== I15_actual.size || [...I15_expected].some((I15_token) => !I15_actual.has(I15_token))
    })
    assert.deepEqual(I15_drift, [], `${I15_locale} compliance/fieldTickets translations drop or rename ICU placeholders`)
    const I15_armsDrift = I15_wanted.filter((I15_key) => {
      const I15_expected = I15_arms(I15_source.get(I15_key) ?? '').join(',')
      const I15_actual = I15_arms(I15_catalog.get(I15_key) ?? '').join(',')
      return I15_expected !== I15_actual
    })
    assert.deepEqual(I15_armsDrift, [], `${I15_locale} compliance/fieldTickets translations drop ICU plural/select arms`)
  }
})

const I13_IDENTICAL_BY_FACT = new Set([
  'fr:projects.schedule.view.gantt|Gantt',
  'fr:projects.duplicates.code|Code',
  'fr:projects.duplicates.action|Action',
  'fr:projects.wipBilling.linesTable.source|Source',
  'fr:projects.wipBilling.linesTable.date|Date',
  'fr:projects.wipBilling.linesTable.description|Description',
  'fr:allocations.drivers.fieldDescription|Description',
  'fr:allocations.drivers.inactive|Inactive',
  'fr:allocations.wizard.targets.weight|Ratio',
  'es:projects.schedule.view.gantt|Gantt',
  'es:projects.wipBilling.metrics.original|Original',
  'es:projects.wipBilling.linesTable.original|Original',
  'es:allocations.wizard.policy.applyManual|Manual',
  'es:allocations.wizard.review.sourceValues|{dimension}: {values}',
  'de:projects.schedule.view.gantt|Gantt',
  'de:projects.schedule.view.board|Board',
  'de:projects.duplicates.code|Code',
  'de:projects.duplicates.name|Name',
  'de:projects.duplicates.status|Status',
  'de:projects.wipBilling.table.status|Status',
  'de:projects.wipBilling.trail.system|System',
  'de:allocations.wizard.review.sourceValues|{dimension}: {values}',
  'pt-BR:projects.schedule.view.gantt|Gantt',
  'pt-BR:projects.duplicates.status|Status',
  'pt-BR:projects.wipBilling.table.status|Status',
  'pt-BR:projects.wipBilling.metrics.original|Original',
  'pt-BR:projects.wipBilling.linesTable.original|Original',
  'pt-BR:allocations.wizard.policy.applyManual|Manual',
  'pt-BR:allocations.wizard.review.sourceValues|{dimension}: {values}',
])

const I13_PROJECT_SINGLES = new Set([
  'projects.billing.applicationsPermissionRequired',
  'projects.charges.operator',
  'projects.charges.selectOperator',
  'projects.charges.operatorNeedsEquipment',
])

const I13_ALLOC_SCATTERED = new Set([
  'allocations.rules.list.emptyTitle',
  'allocations.rules.list.emptyDescription',
  'allocations.rules.list.blurb',
  'allocations.rules.definition.documentKindAdd',
  'allocations.rules.definition.noOptions',
  'allocations.rules.definition.approvalFlowNone',
  'allocations.rules.test.book',
  'allocations.drivers.fieldDescription',
  'allocations.drivers.inactive',
  'allocations.drivers.emptyTitle',
  'allocations.drivers.noDimensionValues',
  'allocations.drivers.manualCreateHint',
  'allocations.drivers.valuesAfterSave',
  'allocations.drivers.emptyDescription',
  'allocations.runs.emptyTitle',
  'allocations.runs.summary',
  'allocations.runs.pendingApprovalNotice',
  'allocations.runs.viewApproval',
  'allocations.runs.emptyDescription',
])

test('I13 projects schedule/WIP/duplicates and allocations wizard copy ships translated in every locale', () => {
  // F-i13-001: the schedule, prebill-worksheet (wipBilling) and operator
  // sections of projects, the duplicates merge section (new in de/ja/zh/pt-BR;
  // already translated in fr/es), and the allocations setup wizard plus its
  // rules-list, drivers and runs strays existed only in en — those locales
  // rendered English inside otherwise translated project/allocation screens.
  // Every leaf must exist, keep its ICU placeholders and plural/select arms,
  // and differ from English except for reviewed cognates and placeholder-only
  // skeletons, pinned to the exact term above.
  const I13_source = flattenCatalog('en')
  const I13_allKeys = [...I13_source.keys()]
  const I13_wip = I13_allKeys.filter((I13_key) => I13_key.startsWith('projects.wipBilling.'))
  const I13_schedule = I13_allKeys.filter((I13_key) => I13_key.startsWith('projects.schedule.'))
  const I13_dups = I13_allKeys.filter((I13_key) => I13_key.startsWith('projects.duplicates.'))
  const I13_wizard = I13_allKeys.filter((I13_key) => I13_key.startsWith('allocations.wizard.'))
  assert.equal(I13_wip.length, 90, 'wipBilling source inventory changed; translate the new keys in every locale and re-pin')
  assert.equal(I13_schedule.length, 12, 'schedule source inventory changed; translate the new keys in every locale and re-pin')
  assert.equal(I13_dups.length, 23, 'duplicates source inventory changed; translate the new keys in every locale and re-pin')
  assert.equal(I13_wizard.length, 89, 'wizard source inventory changed; translate the new keys in every locale and re-pin')
  const I13_wanted = I13_allKeys.filter(
    (I13_key) =>
      I13_key.startsWith('projects.wipBilling.') ||
      I13_key.startsWith('projects.schedule.') ||
      I13_key.startsWith('projects.duplicates.') ||
      I13_key.startsWith('allocations.wizard.') ||
      I13_PROJECT_SINGLES.has(I13_key) ||
      I13_ALLOC_SCATTERED.has(I13_key),
  )
  assert.equal(I13_wanted.length, 90 + 12 + 23 + 4 + 89 + 19, 'i13 source inventory changed; re-pin')
  const I13_tokens = (I13_value: string): Set<string> =>
    new Set(I13_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I13_arms = (I13_value: string): string[] => I13_value.match(/, +(plural|select)/g) ?? []
  for (const I13_locale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I13_catalog = flattenCatalog(I13_locale)
    for (const I13_key of I13_wanted) {
      const I13_value = I13_catalog.get(I13_key)
      assert.ok(I13_value && I13_value.trim(), `${I13_locale} is missing ${I13_key}`)
      const I13_identical = [...I13_IDENTICAL_BY_FACT].find((I13_entry) =>
        I13_entry.startsWith(`${I13_locale}:${I13_key}|`),
      )
      if (I13_identical) {
        assert.equal(I13_value, I13_identical.split('|')[1], `${I13_locale}:${I13_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I13_value, I13_source.get(I13_key), `${I13_locale} must not copy English ${I13_key}`)
      }
    }
    const I13_drift = I13_wanted.filter((I13_key) => {
      const I13_expected = I13_tokens(I13_source.get(I13_key) ?? '')
      const I13_actual = I13_tokens(I13_catalog.get(I13_key) ?? '')
      return I13_expected.size !== I13_actual.size || [...I13_expected].some((I13_token) => !I13_actual.has(I13_token))
    })
    assert.deepEqual(I13_drift, [], `${I13_locale} projects/allocations translations drop or rename ICU placeholders`)
    const I13_armsDrift = I13_wanted.filter((I13_key) => {
      const I13_expected = I13_arms(I13_source.get(I13_key) ?? '').join(',')
      const I13_actual = I13_arms(I13_catalog.get(I13_key) ?? '').join(',')
      return I13_expected !== I13_actual
    })
    assert.deepEqual(I13_armsDrift, [], `${I13_locale} projects/allocations translations drop ICU plural/select arms`)
  }
})

// F-i10 entities + documents remediation (i10 slice): 1403 missing keys across
// fr/es/de/ja/zh/pt-BR — the whole entities leaseSections/detail/toasts blocks
// (164 source leaves) and 69 documents leaves (folder tabs, sharing, bulk,
// trash, activity, share toasts, row menu). 1374 were translated; 29 genuine
// cognates stay omitted into the declared fallback manifest (never copied as
// fake translations): fr Code/Type/Charge/Transaction/Date/Description/Parking/
// Actions, de Code/Name/Status, pt-BR Status, es Memo, and the
// placeholder-only entities.propertyManagement.detail.description everywhere.
// Seven documents cognates are written into the catalogs and pinned exact below.
const I10_ENTITIES_PREFIXES = [
  'entities.propertyManagement.toasts.',
  'entities.propertyManagement.leaseSections.',
  'entities.propertyManagement.detail.',
] as const
const I10_DOCUMENTS_KEYS = [
  'activity.empty',
  'activity.events.create',
  'activity.events.delete',
  'activity.events.move',
  'activity.events.rename',
  'activity.events.replace',
  'activity.events.restore',
  'activity.events.share',
  'activity.events.unshare',
  'activity.events.upload',
  'activity.title',
  'bulk.clear',
  'bulk.delete',
  'bulk.deleteConfirm.body',
  'bulk.deleteConfirm.title',
  'bulk.deleteFailed',
  'bulk.deleted',
  'bulk.download',
  'bulk.downloadFailed',
  'bulk.nothingDownloadable',
  'bulk.selectAll',
  'bulk.selected',
  'file.drawer.tabs.activity',
  'file.drawer.tabs.details',
  'file.drawer.tabs.preview',
  'file.drawer.tabs.sharing',
  'folder.downloadZip',
  'folder.tabs.activity',
  'folder.tabs.details',
  'folder.tabs.sharing',
  'rowMenu.manageAccess',
  'rowMenu.properties',
  'share.add',
  'share.addPrincipal',
  'share.inheritedHint',
  'share.kindFile',
  'share.kindFolder',
  'share.noGrants',
  'share.remove',
  'share.rolesGroup',
  'share.selectPrincipal',
  'share.subtitle',
  'share.tiers.editor',
  'share.tiers.editorHint',
  'share.tiers.manager',
  'share.tiers.managerHint',
  'share.tiers.viewer',
  'share.tiers.viewerHint',
  'share.title',
  'share.usersGroup',
  'share.you',
  'toasts.shareFailed',
  'toasts.shareRemoved',
  'toasts.shareUpdated',
  'trash.back',
  'trash.deleteForever',
  'trash.description',
  'trash.empty',
  'trash.folderLabel',
  'trash.inLocation',
  'trash.link',
  'trash.purgeConfirm.body',
  'trash.purgeConfirm.title',
  'trash.purgeFailed',
  'trash.purged',
  'trash.restore',
  'trash.restoreFailed',
  'trash.restored',
  'trash.title',
] as const
const I10_DOCUMENTS_IDENTICAL_BY_FACT = new Set([
  'es:documents.share.rolesGroup|Roles',
  'es:documents.share.tiers.editor|Editor',
  'de:documents.file.drawer.tabs.details|Details',
  'de:documents.folder.tabs.details|Details',
  'de:documents.share.tiers.manager|Manager',
  'de:documents.trash.inLocation|in {location}',
  'pt-BR:documents.share.tiers.editor|Editor',
])

test('I10 entities lease and deposit copy ships translated in every locale', () => {
  // F-i10-001: the leaseSections/detail/toasts blocks existed only in en —
  // fr/es/de/ja/zh/pt-BR rendered English inside otherwise translated
  // property screens. Every leaf must exist (unless a manifest-declared
  // reviewed identical), differ from English, and keep its ICU placeholders
  // and plural/select arms.
  const I10_source = flattenCatalog('en')
  const I10_manifest = readFallbackManifest()
  const I10_wanted = [...I10_source.keys()].filter((I10_key) =>
    I10_ENTITIES_PREFIXES.some((I10_prefix) => I10_key.startsWith(I10_prefix)),
  )
  assert.equal(I10_wanted.length, 164, 'entities lease/deposit source inventory changed; translate the new keys in every locale and re-pin')
  const I10_tokens = (I10_value: string): Set<string> =>
    new Set(I10_value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I10_arms = (I10_value: string): string[] => I10_value.match(/, +(plural|select)/g) ?? []
  for (const I10_locale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I10_declared = new Set(I10_manifest.fallbacks[I10_locale] ?? [])
    const I10_catalog = flattenCatalog(I10_locale)
    for (const I10_key of I10_wanted) {
      if (I10_declared.has(I10_key)) continue
      const I10_value = I10_catalog.get(I10_key)
      assert.ok(I10_value && I10_value.trim(), `${I10_locale} is missing ${I10_key}`)
      // Reviewed identicals ship in the locale file since I18N1 and pin
      // their exact term (same pattern as the documents test below).
      const I10_identical = [...I18N1_IDENTICAL_BY_FACT].find((I10_entry) =>
        I10_entry.startsWith(`${I10_locale}:${I10_key}|`),
      )
      if (I10_identical) {
        assert.equal(I10_value, I10_identical.split('|')[1], `${I10_locale}:${I10_key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I10_value, I10_source.get(I10_key), `${I10_locale} must not copy English ${I10_key}`)
      }
    }
    const I10_present = I10_wanted.filter((I10_key) => !I10_declared.has(I10_key))
    const I10_drift = I10_present.filter((I10_key) => {
      const I10_expected = I10_tokens(I10_source.get(I10_key) ?? '')
      const I10_actual = I10_tokens(I10_catalog.get(I10_key) ?? '')
      return I10_expected.size !== I10_actual.size || [...I10_expected].some((I10_token) => !I10_actual.has(I10_token))
    })
    assert.deepEqual(I10_drift, [], `${I10_locale} entities translations drop or rename ICU placeholders`)
    const I10_armsDrift = I10_present.filter((I10_key) => {
      const I10_expected = I10_arms(I10_source.get(I10_key) ?? '').join(',')
      const I10_actual = I10_arms(I10_catalog.get(I10_key) ?? '').join(',')
      return I10_expected !== I10_actual
    })
    assert.deepEqual(I10_armsDrift, [], `${I10_locale} entities translations drop ICU plural/select arms`)
  }
})

test('I10 documents sharing trash and activity copy ships translated in every locale', () => {
  // F-i10-002: the 69 documents sharing/bulk/trash/activity leaves existed
  // only in en. Every leaf must exist and keep its ICU placeholders and
  // plural/select arms, and differ from English except for reviewed cognates,
  // pinned to the exact term.
  const I10_docSource = flattenCatalog('en')
  assert.equal(I10_DOCUMENTS_KEYS.length, 69, 'documents i10 source inventory changed; translate the new keys in every locale and re-pin')
  for (const I10_docKey of I10_DOCUMENTS_KEYS) {
    assert.ok(I10_docSource.get(`documents.${I10_docKey}`)?.trim(), `English source is missing documents.${I10_docKey}`)
  }
  const I10_docTokens = (I10_docValue: string): Set<string> =>
    new Set(I10_docValue.match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
  const I10_docArms = (I10_docValue: string): string[] => I10_docValue.match(/, +(plural|select)/g) ?? []
  for (const I10_docLocale of ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']) {
    const I10_docCatalog = flattenCatalog(I10_docLocale)
    for (const I10_docKey of I10_DOCUMENTS_KEYS) {
      const I10_docFullKey = `documents.${I10_docKey}`
      const I10_docValue = I10_docCatalog.get(I10_docFullKey)
      assert.ok(I10_docValue && I10_docValue.trim(), `${I10_docLocale} is missing ${I10_docFullKey}`)
      const I10_docIdentical = [...I10_DOCUMENTS_IDENTICAL_BY_FACT].find((I10_docEntry) =>
        I10_docEntry.startsWith(`${I10_docLocale}:${I10_docFullKey}|`),
      )
      if (I10_docIdentical) {
        assert.equal(I10_docValue, I10_docIdentical.split('|')[1], `${I10_docLocale}:${I10_docFullKey} must stay the reviewed identical term`)
      } else {
        assert.notEqual(I10_docValue, I10_docSource.get(I10_docFullKey), `${I10_docLocale} must not copy English ${I10_docFullKey}`)
      }
    }
    const I10_docDrift = I10_DOCUMENTS_KEYS.filter((I10_docKey) => {
      const I10_docFullKey = `documents.${I10_docKey}`
      const I10_docExpected = I10_docTokens(I10_docSource.get(I10_docFullKey) ?? '')
      const I10_docActual = I10_docTokens(I10_docCatalog.get(I10_docFullKey) ?? '')
      return I10_docExpected.size !== I10_docActual.size || [...I10_docExpected].some((I10_docToken) => !I10_docActual.has(I10_docToken))
    })
    assert.deepEqual(I10_docDrift, [], `${I10_docLocale} documents translations drop or rename ICU placeholders`)
    const I10_docArmsDrift = I10_DOCUMENTS_KEYS.filter((I10_docKey) => {
      const I10_docFullKey = `documents.${I10_docKey}`
      const I10_docExpected = I10_docArms(I10_docSource.get(I10_docFullKey) ?? '').join(',')
      const I10_docActual = I10_docArms(I10_docCatalog.get(I10_docFullKey) ?? '').join(',')
      return I10_docExpected !== I10_docActual
    })
    assert.deepEqual(I10_docArmsDrift, [], `${I10_docLocale} documents translations drop ICU plural/select arms`)
  }
})
const I14_IDENTICAL_BY_FACT = new Set([
  // HR-16 report columns: these headings are the same word in the target
  // language, reviewed one by one — Version/Status/Name/Error/Action/Code
  // are borrowed or identical forms, not untranslated English.
  // The natural-language report prompt's label: "Question" is the French word,
  // spelled identically to the English. de/es/ja/pt-BR/zh all differ, which is
  // what distinguishes a genuine cognate here from an untranslated string.
  'fr:reports.custom.nl.question|Question',
  // The credit-application panel's document column: "Document" is the French
  // word, spelled identically. de (Beleg), es/pt-BR (Documento), ja (伝票) and
  // zh (单据) all differ, which is what separates a genuine cognate here from
  // a string nobody translated.
  'fr:payments.creditApplications.document|Document',
  // Likewise "Status" in German, which the automations columns below already
  // record as a reviewed identical term.
  'de:reports.custom.nl.status|Status',
  // HR-21's payroll-anomaly and AI-capability report columns: Status and Name
  // are the same words in German, exactly as the automations columns below.
  'de:reports.catalog.columns.payroll_anomaly_flags.status|Status',
  'de:reports.catalog.columns.ai_capabilities.name|Name',
  'de:reports.catalog.columns.automations.name|Name',
  'de:reports.catalog.columns.automations.status|Status',
  'pt-BR:reports.catalog.columns.automations.status|Status',
  'de:reports.catalog.columns.automations.version|Version',
  'fr:reports.catalog.columns.automations.version|Version',
  'es:reports.catalog.columns.automations.error_message|Error',
  'de:reports.catalog.columns.automation_runs.status|Status',
  'pt-BR:reports.catalog.columns.automation_runs.status|Status',
  'de:reports.catalog.columns.automation_runs.version|Version',
  'fr:reports.catalog.columns.automation_runs.version|Version',
  'es:reports.catalog.columns.automation_runs.error|Error',
  'fr:reports.catalog.columns.hrm_action_reasons.action|Action',
  'de:reports.catalog.columns.hrm_action_reasons.reason_code|Code',
  'fr:reports.catalog.columns.hrm_action_reasons.reason_code|Code',
  // HR-19 report columns: these headings are the same word in the target
  // language, reviewed one by one — Person/Status/Name/Document/Action/
  // Invitations/Manager are borrowed or identical forms, not untranslated
  // English.
  'de:reports.catalog.columns.hrm_documents.person|Person',
  'de:reports.catalog.columns.hrm_documents.status|Status',
  'de:reports.catalog.columns.hrm_document_signers.status|Status',
  'de:reports.catalog.columns.hrm_survey_results.name|Name',
  'de:reports.catalog.columns.hrm_survey_results.status|Status',
  'fr:reports.catalog.columns.hrm_documents.document_id|Document (id)',
  'fr:reports.catalog.columns.hrm_document_signers.document|Document',
  'fr:reports.catalog.columns.hrm_document_signers.document_id|Document (id)',
  'fr:reports.catalog.columns.hrm_retention_actions.document|Document',
  'fr:reports.catalog.columns.hrm_retention_actions.action|Action',
  'fr:reports.catalog.columns.hrm_retention_actions.document_id|Document (id)',
  'fr:reports.catalog.columns.hrm_survey_results.invitations|Invitations',
  'fr:reports.catalog.columns.hrm_org_chart.manager|Manager',
  'pt-BR:reports.catalog.columns.hrm_documents.status|Status',
  'pt-BR:reports.catalog.columns.hrm_document_signers.status|Status',
  'pt-BR:reports.catalog.columns.hrm_survey_results.status|Status',
  // HR-20 report columns: these headings are the same word in the target
  // language, reviewed one by one — Action/Source are ordinary French,
  // Status is the ordinary German and pt-BR term, Latitude/Longitude are
  // identical forms in fr/es/de/pt-BR, not untranslated English.
  'fr:reports.catalog.columns.field_clock_events.kind|Action',
  'fr:reports.catalog.columns.field_clock_events.source|Source',
  'de:reports.catalog.columns.field_clock_events.status|Status',
  'pt-BR:reports.catalog.columns.field_clock_events.status|Status',
  'fr:reports.catalog.columns.field_clock_coordinates.latitude|Latitude',
  'es:reports.catalog.columns.field_clock_coordinates.latitude|Latitude',
  'de:reports.catalog.columns.field_clock_coordinates.latitude|Latitude',
  'pt-BR:reports.catalog.columns.field_clock_coordinates.latitude|Latitude',
  'fr:reports.catalog.columns.field_clock_coordinates.longitude|Longitude',
  'es:reports.catalog.columns.field_clock_coordinates.longitude|Longitude',
  'de:reports.catalog.columns.field_clock_coordinates.longitude|Longitude',
  'pt-BR:reports.catalog.columns.field_clock_coordinates.longitude|Longitude',
  'de:reports.catalog.columns.crew_time_batches.status|Status',
  'pt-BR:reports.catalog.columns.crew_time_batches.status|Status',
  // HR-20b: HR-17's keys, red on mainline fe8f4175f (copies of en with no
  // identical entry). Each is the ordinary word in the target language —
  // Session/Performance are French, Feedback/Status are the German and
  // pt-BR terms (HR-17 itself kept pt-BR hrmFeedback.title as Feedback) —
  // added so the re-pinned suite is green; HR-17 owns the copy.
  'fr:reports.catalog.columns.hrm_calibration_entries.session|Session',
  'fr:reports.catalog.columns.hrm_talent_reviews.performance_key|Performance',
  'de:reports.catalog.entities.hrm_feedback.label|Feedback',
  'de:reports.catalog.columns.hrm_one_on_ones.status|Status',
  'pt-BR:reports.catalog.entities.hrm_feedback.label|Feedback',
  'pt-BR:reports.catalog.columns.hrm_one_on_ones.status|Status',
  'pt-BR:reports.catalog.columns.hrm_feedback.id|Feedback (id)',
    'de:reports.catalog.columns.hrm_benefit_enrollments.person|Person',
    'de:reports.catalog.columns.hrm_benefit_enrollments.plan|Plan',
    'de:reports.catalog.columns.hrm_benefit_enrollments.status|Status',
    'es:reports.catalog.columns.hrm_benefit_enrollments.plan|Plan',
    'fr:reports.catalog.columns.hrm_change_requests.action|Action',
  // Spanish 'General' is the reviewed cognate for the payroll General sub-tab.
  'es:parties.drawer.payrollTabs.general|General',
    'de:reports.catalog.columns.hrm_employment_history.person|Person',
    'de:reports.catalog.columns.hrm_employment_history.status|Status',
    'de:reports.catalog.columns.hrm_employment_history.version_no|Version',
    'de:reports.catalog.columns.hrm_change_requests.status|Status',
    'pt-BR:reports.catalog.entities.hrm_headcount.label|Headcount',
    'pt-BR:reports.catalog.columns.hrm_headcount.headcount|Headcount',
    'pt-BR:reports.catalog.columns.hrm_employment_history.status|Status',
    'pt-BR:reports.catalog.columns.hrm_change_requests.status|Status',
    'de:reports.catalog.columns.hrm_positions.code|Code',
    // HR-13: reviewed cognates in the construction report columns.
    'de:reports.catalog.columns.hrm_per_diem_entries.status|Status',
    'de:reports.catalog.columns.hrm_certified_runs.status|Status',
    'de:reports.catalog.columns.hrm_certified_runs.format_key|Format',
    'de:reports.catalog.columns.hrm_compliance_findings.status|Status',
    'fr:reports.catalog.columns.hrm_rate_schedule_lines.classification|Classification',
    'fr:reports.catalog.columns.hrm_certified_runs.format_key|Format',
    'pt-BR:reports.catalog.columns.hrm_per_diem_entries.status|Status',
    'pt-BR:reports.catalog.columns.hrm_certified_runs.status|Status',
    'pt-BR:reports.catalog.columns.hrm_compliance_findings.status|Status',
    'de:reports.catalog.columns.hrm_positions.status|Status',
    'fr:reports.catalog.columns.hrm_positions.code|Code',
    'pt-BR:reports.catalog.columns.hrm_positions.status|Status',
    // HR-14: reviewed cognates in the qualification report columns —
    // Status/Type/Qualification spell identically in de/pt-BR/fr, and
    // fr keeps the "(id)" qualifier convention untranslated.
    'de:reports.catalog.columns.hrm_qualifications.status|Status',
    'pt-BR:reports.catalog.columns.hrm_qualifications.status|Status',
    'fr:reports.catalog.entities.hrm_qualifications.label|Qualifications',
    'fr:reports.catalog.columns.hrm_qualifications.type_name|Type',
    'fr:reports.catalog.columns.hrm_qualifications.qualification_id|Qualification (id)',
    'fr:reports.catalog.columns.hrm_qualification_alerts.type_name|Type',
    'fr:reports.catalog.columns.hrm_qualification_alerts.qualification_id|Qualification (id)',
    // HR-18: reviewed cognates in the recruiting-depth report columns —
    // Signature, Version, Note (fr), No (es), Version, Pool (de) are the
    // correct terms in those locales, not untranslated English.
    'fr:reports.catalog.columns.hrm_offers.signature_status|Signature',
    'fr:reports.catalog.columns.hrm_offers.version|Version',
    'fr:reports.catalog.columns.hrm_pool_members.note|Note',
    'es:reports.catalog.columns.hrm_scorecards.no|No',
    'de:reports.catalog.columns.hrm_offers.version|Version',
    'de:reports.catalog.columns.hrm_pool_members.pool|Pool',
  "de:accounts.types.assetBank|Bank",
  "de:common.actions.pdf|PDF",
  "de:common.auditTrail.systemActor|System",
  "de:common.auditTrail.tabs.details|Details",
  "de:common.labels.name|Name",
  "de:common.labels.optional|Optional",
  "de:common.labels.status|Status",
  "de:common.status.ok|OK",
  "de:common.transactionTypes.journal|Journal",
  "de:crm.accounts.lead.title|Leads",
  "de:crm.fields.status|Status",
  "de:crm.fields.website|Website",
  "de:crm.forecasts.pipeline|Pipeline",
  "de:crm.priorities.normal|Normal",
  "de:crm.setup.columns.is_active|Status",
  "de:crm.setup.columns.manager_name|Manager",
  "de:crm.setup.columns.name|Name",
  "de:crm.setup.fields.name|Name",
  "de:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "de:crm.setup.manager|Manager",
  // Cycle-count cognates (0200): the French inventory lot and the pt-BR
  // inventory item are the trade terms in those locales, identical to
  // English by fact rather than by copy.
  "fr:inventory.counts.columns.lot|Lot",
  "pt-BR:inventory.counts.columns.item|Item",
  "de:crm.setup.title|CRM",
  "de:crm.stages.lead|Lead",
  "de:customization.designer.forms.kinds.dropdown|Dropdown",
  "de:customization.designer.forms.kinds.status|Status",
  "de:customization.designer.forms.kinds.text|Text",
  "de:customization.designer.forms.standardName|Standard {type}",
  "de:customization.designer.list.filterOperator|Operator",
  "de:customization.property.tabs.cam|CAM",
  "de:customization.recordTypes.budget_scenario|Budget",
  "de:customization.recordTypes.lead|Lead",
  "de:customization.recordTypes.prospect|Prospect",
  "de:dashboard.metricContext.dpo|DPO {days}",
  "de:dashboard.metricContext.dso|DSO {days}",
  "de:dashboard.orgDescription|{name} · {currency} · {book}",
  "de:dashboard.palette.title|Widgets",
  "de:dashboard.quickActions.editor.link|Link",
  "de:dashboard.title|Dashboard",
  "de:data.export.format|Format",
  "de:data.history.format|Format",
  "de:data.history.status|Status",
  "de:data.import.status|Status",
  "de:data.nav.export|Export",
  "de:data.nav.group|Import & Export",
  "de:data.nav.import|Import",
  "de:inventory.advanced.landed.basis|Basis",
  "de:inventory.advanced.landed.table.basis|Basis",
  "de:inventory.advanced.landed.table.status|Status",
  "de:inventory.advanced.transfers.table.status|Status",
  "de:items.costing.methods.fifo|FIFO",
  "de:items.drawer.codePlaceholder|SVC-01",
  "de:items.labels.code|Code",
  "de:items.rates.tierAuto|auto",
  "de:items.revrec.allocationOptions.normal|Normal",
  "de:journal.detail.contributors.otherGroup|{kind}: {name}",
  "de:journal.list.title|Journal",
  "de:journal.origins.migration|Migration",
  "de:labor-pricing.adjustmentCode|Code",
  "de:labor-pricing.adjustmentName|Name",
  "de:labor-pricing.categories.minimum|Minimum",
  "de:labor-pricing.filters.dimension|Dimension",
  "de:labor-pricing.name|Name",
  "de:labor-pricing.status|Status",
  "de:login.mfaPlaceholder|123456",
  "de:nav.groups.compliance|Compliance",
  "de:nav.groups.pipeline|Pipeline",
  "de:nav.modules.admin|Administration",
  "de:nav.modules.admin-extensions|Apps",
  "de:nav.modules.apps|Apps",
  "de:nav.modules.budgets|Budgets",
  "de:nav.modules.compliance|Compliance",
  "de:nav.modules.dashboard|Dashboard",
  "de:nav.modules.flows|Flows",
  "de:nav.modules.insights|Dashboards",
  "de:parties.drawer.contactName|Name",
  "de:parties.drawer.currencyPlaceholder|CAD",
  "de:parties.drawer.kindPerson|Person",
  "de:parties.drawer.paymentMethods.eft|EFT",
  "de:parties.drawer.shortCodePlaceholder|ACME",
  "de:parties.drawer.tabs.compliance|Compliance",
  "de:parties.drawer.wages.basis|Basis",
  "de:parties.drawer.website|Website",
  "de:payments.drawer.columns.original|Original",
  "de:payments.drawer.kind.journal|Journal",
  "de:payments.runDrawer.systemActor|System",
  "de:payments.runs.method.ach|ACH",
  "de:payments.runs.method.eft|EFT",
  "de:payments.runs.method.positive_pay|Positive Pay",
  "de:payments.runs.method.sepa|SEPA",
  "de:pdfTemplates.editor.code|HTML",
  "de:pdfTemplates.editor.design|Design",
  "de:pdfTemplates.list.name|Name",
  "de:pdfTemplates.pdfButton.label|PDF",
  "de:records.fieldTypes.select.label|Dropdown",
  "de:records.typeBuilder.formula.formatText|Text",
  "de:records.typeBuilder.formula.operation|Operation",
  "de:records.typeBuilder.formula.ops.max|Maximum",
  "de:records.typeBuilder.formula.ops.min|Minimum",
  "de:records.typeBuilder.formula.rollupMax|Maximum",
  "de:records.typeBuilder.formula.rollupMin|Minimum",
  "de:records.typeBuilder.formula.textPlaceholder|Text…",
  "de:records.typeBuilder.maximum|Maximum",
  "de:records.typeBuilder.minimum|Minimum",
  "de:records.typeBuilder.optionPlaceholder|Option {n}",
  "de:records.typeBuilder.sectionDefaultTitle|Details",
  "de:reports.aggs.max|Max",
  "de:reports.aggs.min|Min",
  "de:reports.aging.buckets.b1|1–30",
  "de:reports.aging.buckets.b2|31–60",
  "de:reports.aging.buckets.b3|61–90",
  "de:reports.aging.buckets.b4|90+",
  "de:reports.aging.detail|Detail",
  "de:reports.aging.inCurrency|in {currency}",
  "de:reports.budget.budget|Budget",
  "de:reports.cashFlow.dateRange|{from} → {to}",
  "de:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "de:reports.catalog.columns.accounts.name|Name",
  "de:reports.catalog.columns.allocation_runs.status|Status",
  "de:reports.catalog.columns.documents.status|Status",
  "de:reports.catalog.columns.entitlement_balances.plan|Plan",
  "de:reports.catalog.columns.equipment.name|Name",
  "de:reports.catalog.columns.equipment.status|Status",
  "de:reports.catalog.columns.fixed_assets.name|Name",
  "de:reports.catalog.columns.fixed_assets.status|Status",
  "de:reports.catalog.columns.items.code|Code",
  "de:reports.catalog.columns.items.name|Name",
  "de:reports.catalog.columns.journal_entries.status|Status",
  "de:reports.catalog.columns.parties.display_name|Name",
  "de:reports.catalog.columns.projects.code|Code",
  "de:reports.catalog.columns.projects.manager_name|Manager",
  "de:reports.catalog.columns.projects.name|Name",
  "de:reports.catalog.columns.projects.status|Status",
  "de:reports.catalog.columns.tax_codes.code|Code",
  "de:reports.catalog.columns.tax_codes.name|Name",
  "de:reports.catalog.columns.tax_codes.region|Region",
  "de:reports.catalog.columns.timesheet_weeks.status|Status",
  "de:reports.catalog.columns.timesheets.status|Status",
  "de:reports.catalog.columns.transaction_lines.status|Status",
  "de:reports.catalog.enumValues.journal|Journal",
  "de:reports.custom.builder.agg.max|Max",
  "de:reports.custom.builder.agg.min|Min",
  "de:reports.custom.builder.pageSetup.densityStandard|Standard",
  "de:reports.custom.builder.pageSetup.paperA4|A4",
  "de:reports.custom.builder.pageSetup.paperLegal|Legal",
  "de:reports.custom.builder.pageSetup.paperLetter|Letter",
  "de:reports.custom.builder.tabs.filter|Filter",
  "de:reports.custom.builder.tabs.format|Format",
  "de:reports.custom.runner.csv|CSV",
  "de:reports.export.csv|CSV",
  "de:reports.export.pdf|PDF",
  "de:reports.export.xlsx|Excel",
  "de:reports.filterBar.basis|Basis",
  "de:reports.hub.cards.journalTitle|Journal",
  "de:reports.journal.title|Journal",
  "de:reports.pnl.columns.delta|Δ",
  "de:reports.pnl.columns.deltaPct|Δ%",
  "de:reports.pnl.dateRange|{from} → {to}",
  "de:reports.run.section|{label}: {value}",
  "de:reports.schedule.recipientsPlaceholder|finance@example.com, cfo@example.com",
  "de:shell.accountMenu.roles.controller|Controller",
  "de:shell.accountMenu.sandbox|sandbox",
  "de:shell.apps.title|Apps",
  "de:shell.notifications.kinds.flow|Flow",
  "de:shell.themeToggle.options.system|System",
  "de:sync.drawer.system|System",
  "de:sync.runs.columns.status|Status",
  "de:sync.runs.stats.sourceBook|{kind} {ref}",
  "de:tax.history.columns.status|Status",
  "de:tax.history.columns.version|Version",
  "de:tax.history.export.csv|CSV",
  "de:tax.history.export.pdf|PDF",
  "de:tax.history.export.xlsx|Excel",
  "de:tax.history.statusLabel|Status",
  "de:tax.provisions.columns.status|Status",
  "de:tax.provisions.columns.version|Version",
  "de:tax.provisions.detail.auto|auto",
  "es:approvals.aging.days|{days}d",
  "es:common.actions.pdf|PDF",
  "es:common.labels.memo|Memo",
  "es:common.labels.no|No",
  "es:common.labels.subtotal|Subtotal",
  "es:common.labels.total|Total",
  "es:common.status.error|Error",
  "es:common.status.ok|OK",
  "es:crm.priorities.normal|Normal",
  "es:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "es:crm.setup.states.no|No",
  "es:crm.setup.title|CRM",
  "es:customization.designer.forms.visible|Visible",
  "es:customization.designer.list.scopeUser|Personal",
  "es:customization.property.tabs.cam|CAM",
  "es:customization.property.types.industrial|Industrial",
  "es:customization.recordTypes.lead|Lead",
  "es:customization.views.orgBadge|org",
  "es:dashboard.categories.personal|Personal",
  "es:dashboard.metricContext.dpo|DPO {days}",
  "es:dashboard.metricContext.dso|DSO {days}",
  "es:dashboard.orgDescription|{name} · {currency} · {book}",
  "es:dashboard.palette.title|Widgets",
  "es:dashboard.quickActions.editor.color|Color",
  "es:data.import.error|Error",
  "es:items.drawer.codePlaceholder|SVC-01",
  "es:items.kinds.kit|Kit",
  "es:items.rates.tierAuto|auto",
  "es:items.revrec.allocationOptions.normal|Normal",
  "es:items.revrec.allocationOptions.software|Software (residual)",
  "es:journal.detail.contributors.otherGroup|{kind}: {name}",
  "es:journal.detail.contributors.scriptGroup|Script: {name}",
  "es:journal.origins.manual|Manual",
  "es:login.mfaPlaceholder|123456",
  "es:nav.modules.admin-scripts|Scripts",
  "es:parties.drawer.currencyPlaceholder|CAD",
  "es:parties.drawer.paymentMethods.cheque|Cheque",
  "es:parties.drawer.rolesHeading|Roles",
  "es:parties.drawer.shortCodePlaceholder|ACME",
  "es:parties.drawer.websitePlaceholder|example.com",
  "es:parties.list.roles|Roles",
  "es:payments.drawer.columns.original|Original",
  "es:payments.drawer.totalAmount|Total {amount}",
  "es:payments.runs.method.ach|ACH",
  "es:payments.runs.method.cheque|Cheque",
  "es:payments.runs.method.eft|EFT",
  "es:payments.runs.method.positive_pay|Positive Pay",
  "es:payments.runs.method.sepa|SEPA",
  "es:pdfTemplates.editor.code|HTML",
  "es:pdfTemplates.pdfButton.label|PDF",
  "es:purchaseOrders.shared.totals.subtotal|Subtotal {amount}",
  "es:purchaseOrders.shared.totals.total|Total {amount}",
  "es:reports.aging.buckets.b1|1–30",
  "es:reports.aging.buckets.b2|31–60",
  "es:reports.aging.buckets.b3|61–90",
  "es:reports.aging.buckets.b4|90+",
  "es:reports.aging.columns.total|Total",
  "es:reports.cashFlow.dateRange|{from} → {to}",
  "es:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "es:reports.catalog.columns.allocation_lineage.residual|Residual",
  "es:reports.catalog.columns.allocation_runs.residual|Residual",
  "es:reports.catalog.columns.documents.memo|Memo",
  "es:reports.catalog.columns.documents.subtotal|Subtotal",
  "es:reports.catalog.columns.documents.total|Total",
  "es:reports.catalog.columns.entitlement_balances.plan|Plan",
  "es:reports.catalog.columns.entitlement_balances.plan_id|Plan (id)",
  "es:reports.catalog.columns.entitlement_service_milestones.plan_id|Plan (id)",
  "es:reports.catalog.columns.inventory_lot_movements.memo|Memo",
  "es:reports.catalog.columns.ledger_lines.memo|Memo",
  "es:reports.catalog.enumValues.false|No",
  "es:reports.catalog.enumValues.kit|Kit",
  "es:reports.custom.builder.pageSetup.paperA4|A4",
  "es:reports.custom.builder.pageSetup.paperLegal|Legal",
  "es:reports.custom.runner.csv|CSV",
  "es:reports.custom.runner.trigger.manual|Manual",
  "es:reports.export.csv|CSV",
  "es:reports.export.pdf|PDF",
  "es:reports.export.xlsx|Excel",
  "es:reports.filterBar.breakoutNone|Total",
  "es:reports.pnl.columns.delta|Δ",
  "es:reports.pnl.columns.deltaPct|Δ%",
  "es:reports.pnl.dateRange|{from} → {to}",
  "es:reports.run.no|no",
  "es:reports.run.section|{label}: {value}",
  "es:reports.run.subtotal|{level} — total",
  "es:reports.run.summaryTotal|Total {measure}",
  "es:reports.schedule.recipientsPlaceholder|finance@example.com, cfo@example.com",
  "es:reports.statement.sectionTotal|Total {section}",
  "es:shell.accountMenu.sandbox|sandbox",
  "es:sync.runs.stats.sourceBook|{kind} {ref}",
  "es:sync.sources.qbd.options.AU|Australia",
  "es:tax.history.export.csv|CSV",
  "es:tax.history.export.pdf|PDF",
  "es:tax.history.export.xlsx|Excel",
  "es:tax.provisions.detail.auto|auto",
  "es:tax.provisions.detail.manual|manual",
  "fr:approvals.kinds.budget_scenario|budget",
  "fr:approvals.table.document|Document",
  "fr:common.actions.pdf|PDF",
  "fr:common.auditTrail.action|Action",
  "fr:common.labels.actions|Actions",
  "fr:common.labels.date|Date",
  "fr:common.labels.description|Description",
  "fr:common.labels.notes|Notes",
  "fr:common.labels.total|Total",
  "fr:common.labels.type|Type",
  "fr:common.status.ok|OK",
  "fr:common.transactionTypes.journal|Journal",
  "fr:common.transactionTypes.projectChargeShort|Charge",
  "fr:crm.accounts.prospect.title|Prospects",
  "fr:crm.activityKinds.note|Note",
  "fr:crm.fields.date|Date",
  "fr:crm.fields.description|Description",
  "fr:crm.fields.notes|Notes",
  "fr:crm.forecasts.pipeline|Pipeline",
  "fr:crm.forecasts.quota|Quota",
  "fr:crm.forecasts.quotas|Quotas",
  "fr:crm.forecasts.snapshotType|Type",
  "fr:crm.opportunities.statuses.qualification|Qualification",
  "fr:crm.setup.columns.description|Description",
  "fr:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "fr:crm.setup.tabs.quotas|Quotas",
  "fr:crm.setup.title|CRM",
  "fr:crm.stages.prospect|Prospect",
  "fr:customization.designer.documentation|Documentation",
  "fr:customization.designer.forms.fieldOptions|Options",
  "fr:customization.designer.forms.kinds.date|Date",
  "fr:customization.designer.forms.visible|Visible",
  "fr:customization.designer.list.isActive|Active",
  "fr:customization.property.tabs.cam|CAM",
  "fr:customization.property.types.commercial|Commercial",
  "fr:customization.recordTypes.budget_scenario|Budget",
  "fr:customization.recordTypes.lead|Lead",
  "fr:customization.recordTypes.prospect|Prospect",
  "fr:customization.views.orgBadge|org",
  "fr:dashboard.categories.admin|Administration",
  "fr:dashboard.metricContext.dpo|DPO {days}",
  "fr:dashboard.metricContext.dso|DSO {days}",
  "fr:dashboard.orgDescription|{name} · {currency} · {book}",
  "fr:dashboard.palette.title|Widgets",
  "fr:dashboard.quickActions.editor.maxReached|Maximum {count} actions",
  "fr:data.export.format|Format",
  "fr:data.history.format|Format",
  "fr:data.import.message|Message",
  "fr:data.import.steps.source|Source",
  "fr:inventory.advanced.landed.table.date|Date",
  "fr:inventory.advanced.lots.table.lot|Lot",
  "fr:inventory.drawer.action|Action",
  "fr:inventory.labels.date|Date",
  "fr:inventory.labels.kind|Type",
  "fr:items.costing.trackingOptions.lot|Lot",
  "fr:items.drawer.categoryPlaceholder|Services",
  "fr:items.drawer.codePlaceholder|SVC-01",
  "fr:items.kinds.absence|Absence",
  "fr:items.kinds.service|Service",
  "fr:items.labels.code|Code",
  "fr:items.rates.documentation|Documentation",
  "fr:items.rates.tierAuto|auto",
  "fr:journal.list.title|Journal",
  "fr:journal.origins.migration|Migration",
  "fr:labor-pricing.adjustmentCode|Code",
  "fr:labor-pricing.calculations.distance|Distance",
  "fr:labor-pricing.categories.minimum|Minimum",
  "fr:labor-pricing.docs|Documentation",
  "fr:labor-pricing.filters.dimension|Dimension",
  "fr:labor-pricing.placements.conditions|Conditions",
  "fr:login.mfaPlaceholder|123456",
  "fr:nav.groups.pipeline|Pipeline",
  "fr:nav.modules.admin|Administration",
  "fr:nav.modules.admin-scripts|Scripts",
  "fr:nav.modules.banking-transactions|Transactions",
  "fr:nav.modules.budgets|Budgets",
  "fr:nav.modules.continuous-close|Agents",
  "fr:nav.modules.docs|Documentation",
  "fr:nav.modules.notifications|Notifications",
  "fr:parties.drawer.contactsHeading|Contacts",
  "fr:parties.drawer.currencyPlaceholder|CAD",
  "fr:parties.drawer.shortCodePlaceholder|ACME",
  "fr:parties.drawer.summary.transactions|Transactions",
  "fr:parties.drawer.tabs.contacts|Contacts",
  "fr:parties.drawer.tabs.transactions|Transactions",
  "fr:parties.drawer.transactionCount|{count, plural, one {# transaction} other {# transactions}}",
  "fr:parties.drawer.transactionsHeading|Transactions",
  "fr:parties.drawer.wages.documentation|Documentation",
  "fr:payments.drawer.columns.document|Document",
  "fr:payments.drawer.kind.journal|Journal",
  "fr:payments.drawer.totalAmount|Total {amount}",
  "fr:payments.runs.method.ach|ACH",
  "fr:payments.runs.method.eft|EFT",
  "fr:payments.runs.method.positive_pay|Positive Pay",
  "fr:payments.runs.method.sepa|SEPA",
  "fr:pdfTemplates.editor.code|HTML",
  "fr:pdfTemplates.editor.design|Design",
  "fr:pdfTemplates.editor.portrait|Portrait",
  "fr:pdfTemplates.pdfButton.label|PDF",
  "fr:purchaseOrders.shared.totals.total|Total {amount}",
  "fr:records.fieldTypes.date.label|Date",
  "fr:records.typeBuilder.formula.ops.max|Maximum",
  "fr:records.typeBuilder.formula.ops.min|Minimum",
  "fr:records.typeBuilder.formula.rollupMax|Maximum",
  "fr:records.typeBuilder.formula.rollupMin|Minimum",
  "fr:records.typeBuilder.maximum|Maximum",
  "fr:records.typeBuilder.minimum|Minimum",
  "fr:records.typeBuilder.optionPlaceholder|Option {n}",
  "fr:records.typeBuilder.options|Options",
  "fr:records.typeBuilder.sectionsLabel|Sections",
  "fr:reports.aggs.max|Max",
  "fr:reports.aggs.min|Min",
  "fr:reports.aging.buckets.b1|1–30",
  "fr:reports.aging.buckets.b2|31–60",
  "fr:reports.aging.buckets.b3|61–90",
  "fr:reports.aging.buckets.b4|90+",
  "fr:reports.aging.columns.total|Total",
  "fr:reports.budget.budget|Budget",
  "fr:reports.cashFlow.dateRange|{from} → {to}",
  "fr:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "fr:reports.catalog.columns.accounts.description|Description",
  "fr:reports.catalog.columns.accounts.parent_id|Parent (id)",
  "fr:reports.catalog.columns.accounts.type|Type",
  "fr:reports.catalog.columns.allocation_lineage.mode|Mode",
  "fr:reports.catalog.columns.documents.id|Transaction (id)",
  "fr:reports.catalog.columns.documents.kind|Type",
  "fr:reports.catalog.columns.documents.total|Total",
  "fr:reports.catalog.columns.equipment.description|Description",
  "fr:reports.catalog.columns.inventory_lot_movements.document_id|Transaction (id)",
  "fr:reports.catalog.columns.inventory_lot_movements.lot_id|Lot (id)",
  "fr:reports.catalog.columns.items.code|Code",
  "fr:reports.catalog.columns.items.description|Description",
  "fr:reports.catalog.columns.items.kind|Type",
  "fr:reports.catalog.columns.projects.code|Code",
  "fr:reports.catalog.columns.tax_codes.code|Code",
  "fr:reports.catalog.columns.transaction_lines.description|Description",
  "fr:reports.catalog.columns.transaction_lines.document_id|Transaction (id)",
  "fr:reports.catalog.columns.transaction_lines.kind|Type",
  "fr:reports.catalog.entities.documents.label|Transactions",
  "fr:reports.catalog.enumValues.absence|Absence",
  "fr:reports.catalog.enumValues.kit|Kit",
  "fr:reports.catalog.enumValues.service|Service",
  "fr:reports.custom.builder.agg.max|Max",
  "fr:reports.custom.builder.agg.min|Min",
  "fr:reports.custom.builder.mode|Mode",
  "fr:reports.custom.builder.pageSetup.densityStandard|Standard",
  "fr:reports.custom.builder.pageSetup.orientation|Orientation",
  "fr:reports.custom.builder.pageSetup.paperA4|A4",
  "fr:reports.custom.builder.pageSetup.portrait|Portrait",
  "fr:reports.custom.builder.source|Source",
  "fr:reports.custom.filterTree.addCondition|Condition",
  "fr:reports.custom.runner.csv|CSV",
  "fr:reports.export.columns.type|Type",
  "fr:reports.export.csv|CSV",
  "fr:reports.export.pdf|PDF",
  "fr:reports.export.xlsx|Excel",
  "fr:reports.filterBar.breakoutNone|Total",
  "fr:reports.filterBar.options|Options",
  "fr:reports.filterBar.scaleMillions|Millions",
  "fr:reports.generalLedger.columns.date|Date",
  "fr:reports.hub.cards.journalTitle|Journal",
  "fr:reports.journal.title|Journal",
  "fr:reports.orders.columns.convRate|Conversion",
  "fr:reports.orders.columns.type|Type",
  "fr:reports.pnl.columns.delta|Δ",
  "fr:reports.pnl.columns.deltaPct|Δ%",
  "fr:reports.pnl.dateRange|{from} → {to}",
  "fr:reports.run.csvSection|Section",
  "fr:reports.run.subtotal|{level} — total",
  "fr:reports.run.summarySource|Source",
  "fr:reports.catalog.columns.hrm_leave_absences.on_date|Date",
  "fr:reports.catalog.columns.hrm_leave_absences.source|Source",
  "fr:reports.catalog.columns.hrm_leave_absences.id|Absence (id)",
  "de:reports.catalog.columns.hrm_leave_absences.person|Person",
  "fr:reports.run.summaryTotal|Total {measure}",
  "fr:reports.schedule.recipientsPlaceholder|finance@example.com, cfo@example.com",
  "fr:reports.statement.sectionTotal|Total {section}",
  "fr:shell.accountMenu.sandbox|sandbox",
  "fr:shell.globalSearch.groups.contacts|Contacts",
  "fr:shell.globalSearch.groups.transactions|Transactions",
  "fr:shell.mobileNav.menu|Menu",
  "fr:shell.notifications.ariaLabel|Notifications",
  "fr:shell.notifications.kindLabel|Type",
  "fr:shell.notifications.title|Notifications",
  "fr:sync.netsuite.documentation|Documentation",
  "fr:sync.qbd.documentation|Documentation",
  "fr:sync.runs.stats.sourceBook|{kind} {ref}",
  "fr:sync.sources.qbd.options.CA|Canada",
  "fr:tax.columns.description|Description",
  "fr:tax.history.columns.version|Version",
  "fr:tax.history.export.csv|CSV",
  "fr:tax.history.export.pdf|PDF",
  "fr:tax.history.export.xlsx|Excel",
  "fr:tax.history.lineDescription|Description",
  "fr:tax.provisions.categories.provisions|Provisions",
  "fr:tax.provisions.columns.version|Version",
  "fr:tax.provisions.compute.categories.provisions|Provisions",
  "fr:tax.provisions.compute.descriptionPlaceholder|Description",
  "fr:tax.provisions.detail.auto|auto",
  "ja:common.actions.pdf|PDF",
  "ja:common.status.ok|OK",
  "ja:common.transactionTypes.purchaseOrderShort|PO",
  "ja:common.transactionTypes.salesOrderShort|SO",
  "ja:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "ja:crm.setup.percent|{value}%",
  "ja:crm.setup.title|CRM",
  "ja:customization.property.tabs.cam|CAM",
  "ja:dashboard.metricContext.dpo|DPO {days}",
  "ja:dashboard.metricContext.dso|DSO {days}",
  "ja:dashboard.orgDescription|{name} · {currency} · {book}",
  "ja:items.drawer.codePlaceholder|SVC-01",
  "ja:login.mfaPlaceholder|123456",
  "ja:login.tagline|run on open books",
  "ja:parties.drawer.currencyPlaceholder|CAD",
  "ja:parties.drawer.paymentMethods.eft|EFT",
  "ja:parties.drawer.shortCodePlaceholder|ACME",
  "ja:parties.drawer.websitePlaceholder|example.com",
  "ja:payments.runs.method.ach|ACH",
  "ja:payments.runs.method.eft|EFT",
  "ja:payments.runs.method.positive_pay|Positive Pay",
  "ja:payments.runs.method.sepa|SEPA",
  "ja:pdfTemplates.editor.code|HTML",
  "ja:pdfTemplates.pdfButton.label|PDF",
  "ja:pdfTemplates.send.toPlaceholder|customer@example.com",
  "ja:reports.cashFlow.dateRange|{from} → {to}",
  "ja:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "ja:reports.custom.builder.pageSetup.paperA4|A4",
  "ja:reports.custom.runner.csv|CSV",
  "ja:reports.export.csv|CSV",
  "ja:reports.export.pdf|PDF",
  "ja:reports.export.xlsx|Excel",
  "ja:reports.pnl.columns.delta|Δ",
  "ja:reports.pnl.columns.deltaPct|Δ%",
  "ja:reports.pnl.dateRange|{from} → {to}",
  "ja:reports.schedule.recipientsPlaceholder|finance@example.com, cfo@example.com",
  "ja:shell.accountMenu.sandbox|sandbox",
  "ja:sync.runs.stats.sourceBook|{kind} {ref}",
  "ja:tax.adjustmentPlaceholder|0.00",
  "ja:tax.history.export.csv|CSV",
  "ja:tax.history.export.pdf|PDF",
  "ja:tax.history.export.xlsx|Excel",
  "pt-BR:approvals.aging.days|{days}d",
  "pt-BR:common.actions.pdf|PDF",
  "pt-BR:common.labels.item|Item",
  "pt-BR:common.labels.status|Status",
  "pt-BR:common.labels.subtotal|Subtotal",
  "pt-BR:common.labels.total|Total",
  "pt-BR:common.status.ok|OK",
  "pt-BR:crm.accounts.lead.title|Leads",
  "pt-BR:crm.accounts.prospect.title|Prospects",
  "pt-BR:crm.fields.status|Status",
  "pt-BR:crm.forecasts.pipeline|Pipeline",
  "pt-BR:crm.priorities.normal|Normal",
  "pt-BR:crm.setup.columns.is_active|Status",
  "pt-BR:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "pt-BR:crm.setup.percent|{value}%",
  "pt-BR:crm.setup.title|CRM",
  "pt-BR:crm.stages.lead|Lead",
  "pt-BR:crm.stages.prospect|Prospect",
  "pt-BR:customization.designer.forms.kinds.status|Status",
  "pt-BR:customization.property.tabs.cam|CAM",
  "pt-BR:customization.property.types.industrial|Industrial",
  "pt-BR:customization.recordTypes.item|Item",
  "pt-BR:customization.recordTypes.lead|Lead",
  "pt-BR:customization.views.orgBadge|org",
  "pt-BR:dashboard.metricContext.dpo|DPO {days}",
  "pt-BR:dashboard.metricContext.dso|DSO {days}",
  "pt-BR:dashboard.orgDescription|{name} · {currency} · {book}",
  "pt-BR:dashboard.palette.title|Widgets",
  "pt-BR:dashboard.quickActions.editor.link|Link",
  "pt-BR:data.history.status|Status",
  "pt-BR:data.import.status|Status",
  "pt-BR:inventory.advanced.landed.table.status|Status",
  "pt-BR:inventory.advanced.lots.table.item|Item",
  "pt-BR:inventory.advanced.transfers.item|Item",
  "pt-BR:inventory.advanced.transfers.table.status|Status",
  "pt-BR:inventory.labels.item|Item",
  "pt-BR:items.costing.methods.fifo|FIFO",
  "pt-BR:items.drawer.codePlaceholder|SVC-01",
  "pt-BR:items.kinds.kit|Kit",
  "pt-BR:items.rates.tierAuto|auto",
  "pt-BR:items.revrec.allocationOptions.normal|Normal",
  "pt-BR:items.revrec.allocationOptions.software|Software (residual)",
  "pt-BR:journal.detail.contributors.otherGroup|{kind}: {name}",
  "pt-BR:journal.detail.contributors.scriptGroup|Script: {name}",
  "pt-BR:journal.origins.manual|Manual",
  "pt-BR:labor-pricing.item|Item",
  "pt-BR:labor-pricing.status|Status",
  "pt-BR:labor-pricing.targetTypes.item|Item",
  "pt-BR:login.mfaPlaceholder|123456",
  "pt-BR:login.tagline|run on open books",
  "pt-BR:nav.groups.pipeline|Pipeline",
  "pt-BR:nav.modules.admin-extensions|Apps",
  "pt-BR:nav.modules.admin-scripts|Scripts",
  "pt-BR:nav.modules.apps|Apps",
  "pt-BR:parties.drawer.currencyPlaceholder|CAD",
  "pt-BR:parties.drawer.paymentMethods.cheque|Cheque",
  "pt-BR:parties.drawer.paymentMethods.eft|EFT",
  "pt-BR:parties.drawer.shortCodePlaceholder|ACME",
  "pt-BR:payments.drawer.columns.original|Original",
  "pt-BR:payments.drawer.totalAmount|Total {amount}",
  "pt-BR:payments.list.columns.ref|Ref",
  "pt-BR:payments.runBuilder.columns.ref|Ref",
  "pt-BR:payments.runs.method.ach|ACH",
  "pt-BR:payments.runs.method.cheque|Cheque",
  "pt-BR:payments.runs.method.eft|EFT",
  "pt-BR:payments.runs.method.positive_pay|Positive Pay",
  "pt-BR:payments.runs.method.sepa|SEPA",
  "pt-BR:payments.runs.method.wire|Wire",
  "pt-BR:pdfTemplates.editor.code|HTML",
  "pt-BR:pdfTemplates.editor.design|Design",
  "pt-BR:pdfTemplates.pdfButton.label|PDF",
  "pt-BR:purchaseOrders.shared.columns.item|Item",
  "pt-BR:purchaseOrders.shared.totals.subtotal|Subtotal {amount}",
  "pt-BR:purchaseOrders.shared.totals.total|Total {amount}",
  "pt-BR:reports.aging.buckets.b1|1–30",
  "pt-BR:reports.aging.buckets.b2|31–60",
  "pt-BR:reports.aging.buckets.b3|61–90",
  "pt-BR:reports.aging.buckets.b4|90+",
  "pt-BR:reports.aging.columns.total|Total",
  "pt-BR:reports.cashFlow.dateRange|{from} → {to}",
  "pt-BR:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "pt-BR:reports.catalog.columns.allocation_runs.status|Status",
  "pt-BR:reports.catalog.columns.documents.status|Status",
  "pt-BR:reports.catalog.columns.documents.subtotal|Subtotal",
  "pt-BR:reports.catalog.columns.documents.total|Total",
  "pt-BR:reports.catalog.columns.equipment.status|Status",
  "pt-BR:reports.catalog.columns.fixed_assets.status|Status",
  "pt-BR:reports.catalog.columns.inventory_lot_movements.item|Item",
  "pt-BR:reports.catalog.columns.inventory_lot_movements.item_id|Item (id)",
  "pt-BR:reports.catalog.columns.items.id|Item (id)",
  "pt-BR:reports.catalog.columns.journal_entries.status|Status",
  "pt-BR:reports.catalog.columns.projects.status|Status",
  "pt-BR:reports.catalog.columns.timesheet_weeks.status|Status",
  "pt-BR:reports.catalog.columns.timesheets.status|Status",
  "pt-BR:reports.catalog.columns.transaction_lines.item_name|Item",
  "pt-BR:reports.catalog.columns.transaction_lines.status|Status",
  "pt-BR:reports.catalog.enumValues.kit|Kit",
  "pt-BR:reports.custom.builder.pageSetup.paperA4|A4",
  "pt-BR:reports.custom.runner.csv|CSV",
  "pt-BR:reports.custom.runner.trigger.manual|Manual",
  "pt-BR:reports.export.csv|CSV",
  "pt-BR:reports.export.pdf|PDF",
  "pt-BR:reports.export.xlsx|Excel",
  "pt-BR:reports.filterBar.breakoutNone|Total",
  "pt-BR:reports.pnl.columns.delta|Δ",
  "pt-BR:reports.pnl.columns.deltaPct|Δ%",
  "pt-BR:reports.pnl.dateRange|{from} → {to}",
  "pt-BR:reports.run.section|{label}: {value}",
  "pt-BR:shell.accountMenu.roles.controller|Controller",
  "pt-BR:shell.accountMenu.sandbox|sandbox",
  "pt-BR:shell.apps.title|Apps",
  "pt-BR:shell.mobileNav.menu|Menu",
  "pt-BR:sync.runs.columns.status|Status",
  "pt-BR:sync.runs.kind.incremental|Incremental",
  "pt-BR:sync.runs.stats.sourceBook|{kind} {ref}",
  "pt-BR:tax.history.columns.status|Status",
  "pt-BR:tax.history.export.csv|CSV",
  "pt-BR:tax.history.export.pdf|PDF",
  "pt-BR:tax.history.export.xlsx|Excel",
  "pt-BR:tax.history.statusLabel|Status",
  "pt-BR:tax.provisions.detail.auto|auto",
  "pt-BR:tax.provisions.detail.columns.item|Item",
  "pt-BR:tax.provisions.detail.manual|manual",
  "zh:common.actions.pdf|PDF",
  "zh:crm.setup.fields.rulesPlaceholder|[{ \"field\": \"region\", \"operator\": \"equals\", \"value\": \"West\" }]",
  "zh:crm.setup.percent|{value}%",
  "zh:crm.setup.title|CRM",
  "zh:customization.property.tabs.cam|CAM",
  "zh:dashboard.metricContext.dpo|DPO {days}",
  "zh:dashboard.metricContext.dso|DSO {days}",
  "zh:dashboard.orgDescription|{name} · {currency} · {book}",
  "zh:items.drawer.codePlaceholder|SVC-01",
  "zh:login.mfaPlaceholder|123456",
  "zh:login.tagline|run on open books",
  "zh:parties.drawer.currencyPlaceholder|CAD",
  "zh:parties.drawer.shortCodePlaceholder|ACME",
  "zh:parties.drawer.websitePlaceholder|example.com",
  "zh:payments.runs.method.ach|ACH",
  "zh:payments.runs.method.eft|EFT",
  "zh:payments.runs.method.positive_pay|Positive Pay",
  "zh:payments.runs.method.sepa|SEPA",
  "zh:pdfTemplates.editor.code|HTML",
  "zh:pdfTemplates.pdfButton.label|PDF",
  "zh:pdfTemplates.send.toPlaceholder|customer@example.com",
  "zh:reports.aging.buckets.b1|1–30",
  "zh:reports.aging.buckets.b2|31–60",
  "zh:reports.aging.buckets.b3|61–90",
  "zh:reports.aging.buckets.b4|90+",
  "zh:reports.budget.scenarioOption|{name} · FY{year} · {status}",
  "zh:reports.cashFlow.dateRange|{from} → {to}",
  "zh:reports.cashFlowIndirect.dateRange|{from} → {to}",
  "zh:reports.custom.builder.pageSetup.paperA4|A4",
  "zh:reports.custom.builder.pageSetup.paperLegal|Legal",
  "zh:reports.custom.builder.pageSetup.paperLetter|Letter",
  "zh:reports.custom.runner.csv|CSV",
  "zh:reports.export.csv|CSV",
  "zh:reports.export.pdf|PDF",
  "zh:reports.export.xlsx|Excel",
  "zh:reports.pnl.columns.delta|Δ",
  "zh:reports.pnl.columns.deltaPct|Δ%",
  "zh:reports.pnl.dateRange|{from} → {to}",
  "zh:reports.schedule.recipientsPlaceholder|finance@example.com, cfo@example.com",
  "zh:shell.accountMenu.sandbox|sandbox",
  "zh:sync.runs.stats.sourceBook|{kind} {ref}",
  "zh:tax.adjustmentPlaceholder|0.00",
  "zh:tax.history.export.csv|CSV",
  "zh:tax.history.export.pdf|PDF",
  "zh:tax.history.export.xlsx|Excel",
])

const I14_FILE_COUNTS: Record<string, number> = {
  "items": 270,
  "inventory": 186,
  "reports": 1774,
  "sync": 172,
  "login": 33,
  "accounts": 82,
  "approvals": 70,
  "assistant": 63,
  "common": 267,
  "crm": 321,
  "customization": 185,
  "dashboard": 203,
  "data": 95,
  "journal": 61,
  "labor-pricing": 130,
  "nav": 109,
  "parties": 221,
  "payments": 273,
  "pdfTemplates": 52,
  "purchaseOrders": 55,
  "records": 185,
  "shell": 145,
  "tax": 150,
}

test('I14 items/inventory/reports/sync/login/small-catalog copy ships translated in every locale', () => {
  // F-i14: items, inventory, reports, sync, login and the remaining small
  // catalogs (accounts, approvals, assistant, common, crm, customization,
  // dashboard, data, journal, labor-pricing, nav, parties, payments,
  // pdfTemplates, purchaseOrders, records, shell, tax) existed only in en —
  // six locales rendered English inside otherwise translated screens.
  // Every leaf must exist, keep its ICU variables, and differ from English
  // except for reviewed cognates, pinned to the exact term.
  // Placeholder parity compares true ICU variables (block openers,
  // standalone placeholders, nested {{var}}), NOT select/plural arm labels,
  // which are literal text and legitimately translated (e.g. {Paiement}).
  const I14_source = flattenCatalog('en')
  const I14_locales = ['fr', 'es', 'de', 'ja', 'zh', 'pt-BR']
  const I14_icuVars = (I14_value: string): Set<string> => {
    const I14_found = new Set<string>()
    const I14_blocks: Array<[number, number]> = []
    const I14_opener = /\{([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*(plural|select)\b/g
    let I14_m: RegExpExecArray | null
    while ((I14_m = I14_opener.exec(I14_value)) !== null) {
      let I14_depth = 0
      let I14_i = I14_m.index
      for (;;) {
        if (I14_value[I14_i] === '{') I14_depth += 1
        else if (I14_value[I14_i] === '}') {
          I14_depth -= 1
          if (I14_depth === 0) break
        }
        I14_i += 1
      }
      I14_blocks.push([I14_m.index, I14_i + 1])
      const I14_opened = I14_m[1]
      if (I14_opened !== undefined) I14_found.add(I14_opened)
    }
    const I14_masked = I14_value.split('')
    for (const [I14_s, I14_e] of I14_blocks) {
      for (let I14_i = I14_s; I14_i < I14_e; I14_i += 1) I14_masked[I14_i] = ' '
      for (const I14_nested of I14_value.slice(I14_s, I14_e).match(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g) ?? [])
        I14_found.add(I14_nested.replace(/^\{\{|\}\}$/g, ''))
    }
    for (const I14_t of I14_masked.join('').match(/\{[a-zA-Z_][a-zA-Z0-9_]*(?=[,}])/g) ?? [])
      I14_found.add(I14_t.slice(1))
    return I14_found
  }
  const I14_arms = (I14_value: string): string[] => I14_value.match(/, +(plural|select)/g) ?? []
  for (const [I14_file, I14_count] of Object.entries(I14_FILE_COUNTS)) {
    const I14_wanted = [...I14_source.keys()].filter((I14_key) => I14_key.startsWith(`${I14_file}.`))
    assert.equal(I14_wanted.length, I14_count, `i14 ${I14_file} source inventory changed; translate the new keys in every locale and re-pin`)
    for (const I14_locale of I14_locales) {
      const I14_catalog = flattenCatalog(I14_locale)
      for (const I14_key of I14_wanted) {
        const I14_value = I14_catalog.get(I14_key)
        assert.ok(I14_value && I14_value.trim(), `${I14_locale} is missing ${I14_key}`)
        const I14_identical = [...I14_IDENTICAL_BY_FACT].find((I14_entry) =>
          I14_entry.startsWith(`${I14_locale}:${I14_key}|`),
        )
        if (I14_identical) {
          assert.equal(I14_value, I14_identical.split('|')[1], `${I14_locale}:${I14_key} must stay the reviewed identical term`)
        } else {
          assert.notEqual(I14_value, I14_source.get(I14_key), `${I14_locale} must not copy English ${I14_key}`)
        }
      }
      const I14_drift = I14_wanted.filter((I14_key) => {
        const I14_expected = I14_icuVars(I14_source.get(I14_key) ?? '')
        const I14_actual = I14_icuVars(I14_catalog.get(I14_key) ?? '')
        return I14_expected.size !== I14_actual.size || [...I14_expected].some((I14_token) => !I14_actual.has(I14_token))
      })
      assert.deepEqual(I14_drift, [], `${I14_locale} i14 translations drop or rename ICU placeholders`)
      const I14_armsDrift = I14_wanted.filter((I14_key) => {
        const I14_expected = I14_arms(I14_source.get(I14_key) ?? '').join(',')
        const I14_actual = I14_arms(I14_catalog.get(I14_key) ?? '').join(',')
        return I14_expected !== I14_actual
      })
      assert.deepEqual(I14_armsDrift, [], `${I14_locale} i14 translations drop ICU plural/select arms`)
    }
  }
})

test('rate-card labor/material selector labels ship localized in every locale', () => {
  // PRC10: the card target picker offers all-labor / all-materials
  // selectors, so their labels must resolve in every locale instead of
  // rendering the raw key path on the picker.
  const source = flattenCatalog('en')
  const keys = ['labor-pricing.targetTypes.labor', 'labor-pricing.targetTypes.material']
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

test('leave on-behalf filing copy ships localized in every locale', () => {
  // OM-11: the leave drawer renders a manager on-behalf mode (mode labels,
  // employee picker, filer hint, missing-employee refusal) — absent outside
  // en the mode would fall back to English inside otherwise translated
  // drawers. Every leaf must exist and be localized.
  const source = flattenCatalog('en')
  const keys = [
    'hrm.leave.onBehalfFilingForLabel',
    'hrm.leave.onBehalfSelfLabel',
    'hrm.leave.onBehalfOtherLabel',
    'hrm.leave.onBehalfEmployeeLabel',
    'hrm.leave.onBehalfEmployeePlaceholder',
    'hrm.leave.onBehalfHint',
    'hrm.leave.onBehalfEmploymentRequired',
  ]
  for (const key of keys) {
    const english = source.get(key)
    assert.ok(english && english.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of keys) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, source.get(key), `${locale} must localize ${key}`)
    }
  }
})

/**
 * Flatten one catalog FILE with array-aware leaves. next-intl merges message
 * arrays into objects at runtime, so a bare object walk would silently skip
 * array leaves (and an array-vs-object shape mismatch would be invisible).
 * Array elements compare by index: `sync.sources.qbo.steps.0`.
 */
function flattenFileShape(namespace: string, messages: unknown): Map<string, string> {
  const leaves = new Map<string, string>()
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      leaves.set(path, node)
    } else if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}.${index}`))
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        visit(value, `${path}.${key}`)
      }
    }
  }
  visit(messages, namespace)
  return leaves
}

/**
 * Placeholder names carried by a message, brace-aware. A flat
 * /\{[a-zA-Z_]…(?=[,}])/ scan misfires on plural/select literal branches:
 * `=0 {Ereignisdetails}` is prose (one German word in braces) while
 * `=0 {Event details}` is not, so the naive scan reports drift where there
 * is none. Branch bodies are literal wrappers — skipped as names — but
 * nested arguments inside them (`other {# dependents: {names}}`) still
 * count, so a locale dropping `{names}` fails.
 */
function icuTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  const stack: boolean[] = [] // true while inside a plural/select/selectordinal body
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char === '{') {
      if (stack.length > 0 && stack[stack.length - 1]) {
        stack.push(false)
        index += 1
        continue
      }
      const arg = /^\{([a-zA-Z_][a-zA-Z0-9_]*)/.exec(value.slice(index))
      const name = arg?.[1]
      if (!arg || name === undefined) {
        index += 1
        continue
      }
      const rest = value.slice(index + arg[0].length)
      if (rest.startsWith(',')) {
        const typed = /^,\s*([a-zA-Z]+)/.exec(rest)
        const typeName = typed?.[1]
        tokens.add(name)
        stack.push(typeName !== undefined && ['plural', 'select', 'selectordinal'].includes(typeName))
        index += arg[0].length + (typed ? typed[0].length : 0)
      } else if (rest.startsWith('}')) {
        tokens.add(name)
        stack.push(false)
        index += arg[0].length
      } else {
        index += 1
      }
      continue
    }
    if (char === '}') {
      stack.pop()
      index += 1
      continue
    }
    index += 1
  }
  return tokens
}

test('every English message key exists in every locale file (global parity)', () => {
  // I18N1: the per-area pins above cover only SOME namespaces, so whole
  // blocks (accounting lifecycle, expenses settlement, hrm queue detail,
  // property-management fallbacks) shipped English-only while CI stayed
  // green. This test derives the inventory from the files themselves: every
  // leaf of every en file must exist non-empty in the same file in every
  // other locale, with the same ICU placeholders. Reviewed identicals live
  // in I18N1_IDENTICAL_BY_FACT — everything else in the remediated blocks
  // must be translated prose, which the backfill test below enforces.
  const sourceFiles = readdirSync(join(MESSAGES, 'en'))
    .filter((file) => file.endsWith('.json'))
    .sort()
  assert.ok(sourceFiles.length > 0, 'no English catalog files found')

  // Allow-list hygiene: every entry names a real English key and pins the
  // exact term that locale ships — a stale entry fails here, not silently.
  const source = flattenCatalog('en')
  for (const entry of I18N1_IDENTICAL_BY_FACT) {
    const pipe = entry.indexOf('|')
    assert.ok(pipe > 0, `malformed identical-by-fact entry: ${entry}`)
    const scope = entry.slice(0, pipe)
    const term = entry.slice(pipe + 1)
    const colon = scope.indexOf(':')
    const locale = scope.slice(0, colon)
    const key = scope.slice(colon + 1)
    assert.ok(locales.includes(locale), `identical-by-fact entry names an unknown locale: ${entry}`)
    assert.ok(source.has(key), `identical-by-fact entry names a missing English key: ${entry}`)
    const shipped = flattenCatalog(locale).get(key)
    assert.equal(shipped, term, `${locale}:${key} must stay the reviewed identical term`)
  }

  for (const locale of locales) {
    if (locale === 'en') continue
    const files = readdirSync(join(MESSAGES, locale))
      .filter((file) => file.endsWith('.json'))
      .sort()
    assert.deepEqual(files, sourceFiles, `${locale} must ship exactly the English file set`)
    for (const file of sourceFiles) {
      const namespace = file.slice(0, -'.json'.length)
      const enLeaves = flattenFileShape(
        namespace,
        JSON.parse(readFileSync(join(MESSAGES, 'en', file), 'utf8')),
      )
      const locLeaves = flattenFileShape(
        namespace,
        JSON.parse(readFileSync(join(MESSAGES, locale, file), 'utf8')),
      )
      assert.ok(enLeaves.size > 0, `en/${file} contributes no leaves`)
      for (const [key, enValue] of enLeaves) {
        assert.ok(locLeaves.has(key), `${locale}/${file} is missing ${key}`)
        const value = locLeaves.get(key) ?? ''
        assert.ok(value.trim() !== '', `${locale}/${file} leaves ${key} blank`)
        const expected = icuTokens(enValue)
        const actual = icuTokens(value)
        const drift =
          expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
        assert.ok(!drift, `${locale}/${file} ${key} drops or renames ICU placeholders`)
      }
      const extra = [...locLeaves.keys()].filter((key) => !enLeaves.has(key)).sort()
      assert.deepEqual(extra, [], `${locale}/${file} carries keys absent from English`)
    }
  }
})

test('I18N1 backfilled keys are genuinely translated, never English pastes', () => {
  // The global parity test above proves presence; this one proves the new
  // translations are real prose: every backfilled key must differ from
  // English except reviewed identicals, which must match their pinned term
  // exactly. The inventory count pins the remediated surface (58 accounting
  // lifecycle + 8 expenses settlement + 14 hrm queue/offer keys) so a new
  // English-only key in these blocks fails here.
  const prefixes = [
    'accounting.lifecycle.',
    'expenses.drawer.settlement.',
    'expenses.drawer.cardLabel',
    'expenses.drawer.cardPlaceholder',
    'expenses.drawer.noCard',
    'expenses.drawer.splits',
    'hrm.queue.openRequest',
    'hrm.queue.detail',
    'hrm.positions.columns.holdersCount',
    'hrm.public.offer.terms',
  ]
  const source = flattenCatalog('en')
  const wanted = [...source.keys()]
    .filter((key) => prefixes.some((prefix) => key === prefix || key.startsWith(prefix)))
    .sort()
  assert.equal(wanted.length, 80, 'I18N1 backfill inventory changed; translate the new keys everywhere and re-pin')
  for (const key of wanted) {
    assert.ok(source.get(key)?.trim(), `English source is missing ${key}`)
  }
  for (const locale of locales) {
    if (locale === 'en') continue
    const catalog = flattenCatalog(locale)
    for (const key of wanted) {
      const value = catalog.get(key)
      assert.ok(value && value.trim(), `${locale} is missing ${key}`)
      const identical = [...I18N1_IDENTICAL_BY_FACT].find((entry) =>
        entry.startsWith(`${locale}:${key}|`),
      )
      if (identical) {
        assert.equal(value, identical.slice(identical.indexOf('|') + 1), `${locale}:${key} must stay the reviewed identical term`)
      } else {
        assert.notEqual(value, source.get(key), `${locale} must not copy English ${key}`)
      }
    }
    const drift = wanted.filter((key) => {
      const expected = icuTokens(source.get(key) ?? '')
      const actual = icuTokens(catalog.get(key) ?? '')
      return expected.size !== actual.size || [...expected].some((token) => !actual.has(token))
    })
    assert.deepEqual(drift, [], `${locale} backfilled translations drop or rename ICU placeholders`)
  }
})

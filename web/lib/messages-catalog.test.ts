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
import { PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'

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
  assert.equal(propertyKeys.length, 200, 'the property-management source inventory changed')
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
      164,
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
  'payroll.remittances.unassigned': '76d349b2a55266a51b7234236fb74db846e734121b6726058da7fc39a0581b1a',
  'payroll.remittances.withheld': '7f5ad98195ddf9d5da5f3bc2a67f39ed865f94200ecae8c874fac12159ca84d5',
  'payroll.run.approvalNotRequired': '915b6ed78c68b893990815aab4cf5034015617e286e5da2dc018a6f2f9fc8f5e',
  'payroll.run.approvalPending': '209a22c19e77ab07406c80dab264f42ada4775cc507171cc8bb3e0d783a6a83c',
  'payroll.run.approvalSubmitted': 'a0e42da94f35822594798d592ff9c2340469227370f9d8ec1b9af7f1a76e6f6f',
  'payroll.run.calculate': '2121cc15afb6ba5350deb90e1a292faa7d932537a19ddddadff4aeb796a8d595',
  'payroll.run.calculateDone': 'ab4d17df1be5e14501d827733d62e0c092b6122f48f95892cb125628339db90c',
  'payroll.run.commit': '82a9c46ffa4789945d9f2359d75891558ef6faa8dee09e4b25e4e0597704f5bd',
  'payroll.run.commitDone': 'c658f4ed443d30ae20af749910d66fa1791cab0edd50e4eabd63e71667a2cc31',
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
  'payroll.wizard.finish.nextRemit': 'a8381ac809f026ee0457a172aa23b12c3d64bfa3959e3142a1f235a1929f422b',
  'payroll.wizard.finish.nextTitle': 'eaf380e7f60489b7d687971d73fa8687ed68ef0aa7cc9a38310c146b06538067',
  'payroll.wizard.finish.notCommitted': '0307e4d4766e10c40406eb6c00cf7b7c836740ee86a6ca1c2a81f528e61f846c',
  'payroll.wizard.finish.paid': 'fb81b961af456e5e748db7e1b1bff9a5e621b62718234c1937738d1adc317a17',
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

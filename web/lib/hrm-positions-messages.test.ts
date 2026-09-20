import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * HRM positions surface message parity.
 *
 * The positions tab, the headcount-plan vitals, the report catalog entry,
 * and the permission labels render the raw key path when a locale file
 * lacks the key — a silent glitch, never a refusal. This guard names the
 * exact locale and key path so a missing translation reads as a failure,
 * and it pins ICU placeholder parity so a translated string cannot drop
 * {date}, {code}, or {count, plural, ...} and render "undefined" mid-sentence.
 */

const MESSAGES = join(import.meta.dirname, '..', 'messages')
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

type Dict = Record<string, unknown>

function load(locale: string, file: string): Dict {
  return JSON.parse(readFileSync(join(MESSAGES, locale, file), 'utf8')) as Dict
}

function at(obj: Dict, path: string): unknown {
  let node: unknown = obj
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined
    node = (node as Dict)[part]
  }
  return node
}

function placeholders(value: string): Set<string> {
  const found = new Set<string>()
  for (const match of value.matchAll(/\{[a-zA-Z0-9_]+(?:,|\})/g)) {
    found.add(match[0].slice(1, -1).replace(/,$/, ''))
  }
  return found
}

const HRM_KEYS = [
  'home.tabs.positions',
  'home.vitals.openPositions',
  'home.vitals.openPositionsSub',
  'home.attention.unfunded',
  'home.vacancy.title',
  'home.vacancy.department',
  'home.vacancy.employer',
  'home.vacancy.positions',
  'home.vacancy.planned',
  'home.vacancy.funded',
  'home.vacancy.filled',
  'home.vacancy.vacant',
  'home.vacancy.unassignedDepartment',
  'home.vacancy.empty',
  'home.vacancy.total',
  'positions.title',
  'positions.description',
  'positions.statusAll',
  'positions.segmentsLabel',
  'positions.statusPlanned',
  'positions.statusOpen',
  'positions.statusFilled',
  'positions.statusFrozen',
  'positions.statusClosed',
  'positions.columns.code',
  'positions.columns.title',
  'positions.columns.status',
  'positions.columns.department',
  'positions.columns.planned',
  'positions.columns.funded',
  'positions.columns.filled',
  'positions.columns.vacant',
  'positions.columns.holder',
  'positions.columns.unassignedHolder',
  'positions.holdersCount',
  'positions.empty',
  'positions.total',
  'processes.segmentsLabel',
  'processes.columns.status',
  'positions.drawer.versionNo',
  'positions.drawer.effective',
  'positions.drawer.effectiveOpen',
  'positions.drawer.recorded',
  'positions.drawer.funding',
  'positions.drawer.period',
  'positions.drawer.funded',
  'positions.drawer.costPlan',
  'positions.drawer.unfunded',
  'positions.drawer.holder',
  'positions.drawer.holderEmployment',
  'positions.drawer.noHolder',
  'positions.drawer.warnings',
  'positions.drawer.missing',
  'employment.changeRequests.kindPositionAssignment',
  'employment.changeRequests.positionLabel',
  'employment.changeRequests.positionUnset',
  'employment.changeRequests.positionHint',
  'employment.changeRequests.positionRequired',
  'employment.changeRequests.unassignLabel',
  'employment.changeRequests.unassignHint',
]

const REPORT_POSITION_COLUMNS = [
  'code',
  'title',
  'status',
  'employer',
  'department',
  'planned_fte',
  'funded_fte',
  'filled_fte',
  'vacant_fte',
  'position_id',
]

const REPORT_ENUMS = ['position_assignment', 'planned', 'open', 'filled', 'frozen', 'closed']

test('every locale carries the positions surface keys with en placeholder parity', () => {
  const sources = new Map<string, Dict>()
  for (const locale of LOCALES) sources.set(locale, load(locale, 'hrm.json'))
  const en = sources.get('en')!
  for (const locale of LOCALES) {
    if (locale === 'en') continue
    const messages = sources.get(locale)!
    for (const key of HRM_KEYS) {
      const source = at(en, key)
      const value = at(messages, key)
      assert.equal(
        typeof value,
        'string',
        `${locale} hrm.json lacks "${key}" (en: ${JSON.stringify(source)}) — the page would render the key path`,
      )
      assert.deepStrictEqual(
        [...placeholders(value as string)].sort(),
        [...placeholders(source as string)].sort(),
        `${locale} hrm.json "${key}" drops or renames a placeholder (en: ${JSON.stringify(source)}, got: ${JSON.stringify(value)})`,
      )
    }
  }
})

test('every locale catalogs the hrm_positions report entity with its columns and enums', () => {
  for (const locale of LOCALES) {
    const catalog = load(locale, 'reports.json')['catalog'] as Dict
    const entities = catalog['entities'] as Dict
    const columns = catalog['columns'] as Dict
    const enums = catalog['enumValues'] as Dict
    const entity = entities['hrm_positions'] as Dict | undefined
    assert.ok(entity, `${locale} reports.json lacks catalog.entities.hrm_positions — the report hub cannot describe the entity`)
    assert.equal(typeof entity['label'], 'string', `${locale} reports.json hrm_positions entity lacks a label`)
    assert.equal(typeof entity['description'], 'string', `${locale} reports.json hrm_positions entity lacks a description`)
    const mirrored = columns['hrm_positions'] as Dict | undefined
    assert.ok(mirrored, `${locale} reports.json lacks catalog.columns.hrm_positions`)
    assert.deepStrictEqual(
      Object.keys(mirrored ?? {}).sort(),
      [...REPORT_POSITION_COLUMNS].sort(),
      `${locale} reports.json hrm_positions columns drift from the entity: ${Object.keys(mirrored ?? {}).join(',')}`,
    )
    for (const name of REPORT_ENUMS) {
      assert.equal(
        typeof enums[name],
        'string',
        `${locale} reports.json lacks catalog.enumValues.${name} — position status/kind would render as a raw code`,
      )
    }
  }
})

test('every locale labels the position permission grants', () => {
  for (const locale of LOCALES) {
    const permissions = (load(locale, 'admin.json')['permissions'] ?? {}) as Dict
    for (const key of ['hrm_position_read', 'hrm_position_manage']) {
      assert.equal(
        typeof permissions[key],
        'string',
        `${locale} admin.json lacks permissions.${key} — the roles screen would show the raw permission id`,
      )
    }
  }
})

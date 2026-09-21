import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * HR-14 certifications/licenses/dispatch surface message parity.
 *
 * The qualifications ledger page, the drawer, the record dialog, the
 * employment tab, and the two report catalog entries render the raw key
 * path when a locale file lacks the key — a silent glitch, never a
 * refusal. This guard names the exact locale and key path so a missing
 * translation reads as a failure, and it pins ICU placeholder parity so
 * a translated string cannot drop {from} and render undefined.
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

// Every hrm.json leaf the qualifications surface reads: the ledger page
// and its sections, the requirement and coverage blocks, the alert
// block, the drawer, the record form, and the employment/home entry
// points. Pinned so a new copy key without translations fails here.
const HRM_KEYS = [
  'qualifications.title',
  'qualifications.description',
  'qualifications.record',
  'qualifications.recordTitle',
  'qualifications.drawerTitle',
  'qualifications.settings',
  'qualifications.sectionLabel',
  'qualifications.sections.ledger',
  'qualifications.sections.requirements',
  'qualifications.sections.alerts',
  'qualifications.segmentsLabel',
  'qualifications.allLabel',
  'qualifications.typesLabel',
  'qualifications.typesAll',
  'qualifications.listTitle',
  'qualifications.open',
  'qualifications.columns.worker',
  'qualifications.columns.type',
  'qualifications.columns.status',
  'qualifications.columns.expiry',
  'qualifications.columns.subject',
  'qualifications.columns.severity',
  'qualifications.columns.window',
  'qualifications.columns.due',
  'qualifications.columns.sent',
  'qualifications.statusNames.valid',
  'qualifications.statusNames.expiring',
  'qualifications.statusNames.expired',
  'qualifications.statusNames.revoked',
  'qualifications.statusNames.pending_verification',
  'qualifications.emptyTitle',
  'qualifications.emptyDescription',
  'qualifications.requirementsTitle',
  'qualifications.requirementsEmpty',
  'qualifications.coverageTitle',
  'qualifications.coverageProjectLabel',
  'qualifications.coverageProjectAll',
  'qualifications.coverageEmpty',
  'qualifications.coverage.qualified',
  'qualifications.coverage.missing',
  'qualifications.coverage.expired',
  'qualifications.coverage.pending',
  'qualifications.alertsTitle',
  'qualifications.alertsEmpty',
  'qualifications.alertDue',
  'qualifications.taxonomyTitle',
  'qualifications.windowOpen',
  'qualifications.verify',
  'qualifications.renew',
  'qualifications.revoke',
  'qualifications.revokePrompt',
  'qualifications.renewPrompt',
  'qualifications.drawer.issued',
  'qualifications.drawer.identifier',
  'qualifications.drawer.notes',
  'qualifications.drawer.evidence',
  'qualifications.drawer.events',
  'qualifications.recordForm.employment',
  'qualifications.recordForm.type',
  'qualifications.recordForm.issuedOn',
  'qualifications.recordForm.expiresOn',
  'qualifications.recordForm.identifier',
  'qualifications.recordForm.notes',
  'home.tabs.qualifications',
  'home.attention.expiringQualifications',
  'home.attention.expiredQualifications',
  'employment.qualifications.title',
  'employment.qualifications.viewAll',
  'employment.qualifications.empty',
  'me.overview.qualificationsTitle',
  'me.overview.qualificationsEmpty',
  'me.overview.qualificationsEmptyDescription',
  'me.qualifications.columns.type',
  'me.qualifications.columns.expires',
  'me.qualifications.columns.status',
]

const REPORT_QUALIFICATION_COLUMNS = [
  'employee',
  'employer',
  'type_code',
  'type_name',
  'category',
  'identifier',
  'issued_on',
  'expires_on',
  'status',
  'verified_at',
  'qualification_id',
  'employment_id',
]

const REPORT_ALERT_COLUMNS = [
  'employee',
  'type_code',
  'type_name',
  'expires_on',
  'due_on',
  'lead_days',
  'sent_at',
  'channel',
  'alert_id',
  'qualification_id',
]

test('every locale carries the qualifications surface keys with en placeholder parity', () => {
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

test('every locale catalogs the qualification report entities with their columns', () => {
  for (const locale of LOCALES) {
    const catalog = load(locale, 'reports.json')['catalog'] as Dict
    const entities = catalog['entities'] as Dict
    const columns = catalog['columns'] as Dict
    for (const [entity, want] of [
      ['hrm_qualifications', REPORT_QUALIFICATION_COLUMNS],
      ['hrm_qualification_alerts', REPORT_ALERT_COLUMNS],
    ] as const) {
      const entry = entities[entity] as Dict | undefined
      assert.ok(entry, `${locale} reports.json lacks catalog.entities.${entity} — the report hub cannot describe the entity`)
      assert.equal(typeof entry['label'], 'string', `${locale} reports.json ${entity} entity lacks a label`)
      assert.equal(typeof entry['description'], 'string', `${locale} reports.json ${entity} entity lacks a description`)
      const mirrored = columns[entity] as Dict | undefined
      assert.ok(mirrored, `${locale} reports.json lacks catalog.columns.${entity}`)
      assert.deepStrictEqual(
        Object.keys(mirrored ?? {}).sort(),
        [...want].sort(),
        `${locale} reports.json ${entity} columns drift from the entity: ${Object.keys(mirrored ?? {}).join(',')}`,
      )
    }
  }
})

test('every locale labels the certifications permission grants', () => {
  for (const locale of LOCALES) {
    const permissions = (load(locale, 'admin.json')['permissions'] ?? {}) as Dict
    for (const key of ['hrm_certifications_read', 'hrm_certifications_manage']) {
      assert.equal(
        typeof permissions[key],
        'string',
        `${locale} admin.json lacks permissions.${key} — the roles screen would show the raw permission id`,
      )
    }
  }
})

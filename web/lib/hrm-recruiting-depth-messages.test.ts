import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * HR-18 recruiting-depth surface message parity.
 *
 * The depth tabs, drawers, islands, and public pages render the raw key
 * path when a locale file lacks the key — a silent glitch, never a
 * refusal. This guard names the exact locale and key path so a missing
 * translation reads as a failure, and it pins ICU placeholder parity so
 * a translated string cannot drop {count} and render undefined.
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

// Every hrm.json leaf the depth surface reads: the five sub-tabs, the
// depth tables and drawers, the islands, and the public career, booking,
// and offer pages. Pinned so a new copy key without translations fails
// here.
const HRM_KEYS = [
  'public.book.empty',
  'public.book.kicker',
  'public.book.title',
  'public.careers.empty',
  'public.careers.kicker',
  'public.careers.title',
  'public.offer.alreadySigned',
  'public.offer.closed',
  'public.offer.for',
  'public.offer.kicker',
  'public.offer.version',
  'recruiting.consent.future_roles',
  'recruiting.consent.talent_pool',
  'recruiting.consent.this_application',
  'recruiting.depth.applies',
  'recruiting.depth.blinded',
  'recruiting.depth.bookedSlots',
  'recruiting.depth.close',
  'recruiting.depth.columns.applies',
  'recruiting.depth.columns.board',
  'recruiting.depth.columns.candidate',
  'recruiting.depth.columns.job',
  'recruiting.depth.columns.kind',
  'recruiting.depth.columns.members',
  'recruiting.depth.columns.name',
  'recruiting.depth.columns.requisition',
  'recruiting.depth.columns.scorecards',
  'recruiting.depth.columns.signature',
  'recruiting.depth.columns.slots',
  'recruiting.depth.columns.status',
  'recruiting.depth.columns.versions',
  'recruiting.depth.columns.when',
  'recruiting.depth.consentTitle',
  'recruiting.depth.dispositionLog',
  'recruiting.depth.empty',
  'recruiting.depth.failed',
  'recruiting.depth.kit',
  'recruiting.depth.matchToOpening',
  'recruiting.depth.members',
  'recruiting.depth.missing',
  'recruiting.depth.myScorecard',
  'recruiting.depth.others',
  'recruiting.depth.overall',
  'recruiting.depth.pause',
  'recruiting.depth.poolMembers',
  'recruiting.depth.proposeFromPool',
  'recruiting.depth.proposedSlots',
  'recruiting.depth.publish',
  'recruiting.depth.questions',
  'recruiting.depth.remove',
  'recruiting.depth.retentionDate',
  'recruiting.depth.scorecards',
  'recruiting.depth.sendLink',
  'recruiting.depth.signatureState',
  'recruiting.depth.slots',
  'recruiting.depth.submitScorecard',
  'recruiting.depth.summary',
  'recruiting.depth.tagsLabel',
  'recruiting.depth.versionHistory',
  'recruiting.depth.versions',
  'recruiting.depth.voidSignature',
  'recruiting.posting.closed',
  'recruiting.posting.draft',
  'recruiting.posting.error',
  'recruiting.posting.paused',
  'recruiting.posting.published',
  'recruiting.postingEvent.apply_received',
  'recruiting.postingEvent.closed',
  'recruiting.postingEvent.disposition_sent',
  'recruiting.postingEvent.error',
  'recruiting.postingEvent.paused',
  'recruiting.postingEvent.published',
  'recruiting.signature.declined',
  'recruiting.signature.sent',
  'recruiting.signature.signed',
  'recruiting.signature.unsigned',
  'recruiting.signature.viewed',
  'recruiting.signature.voided',
  'recruiting.tabs.interviews',
  'recruiting.tabs.offers',
  'recruiting.tabs.openings',
  'recruiting.tabs.pools',
  'recruiting.tabs.postings',
]

const REPORT_COLUMNS: Record<string, readonly string[]> = {
  hrm_scorecards: [
    'requisition', 'candidate', 'kind', 'scheduled_on', 'panel',
    'submitted', 'strong_no', 'no', 'yes', 'strong_yes', 'interview_id',
  ],
  hrm_interview_slots: [
    'requisition', 'candidate', 'kind', 'starts_at', 'ends_at',
    'timezone', 'booked_on', 'slot_id',
  ],
  hrm_offers: [
    'candidate', 'requisition', 'job_title', 'status', 'signature_status',
    'version', 'sent_on', 'signed_on', 'expires_on', 'offer_id',
  ],
  hrm_postings: [
    'requisition', 'board', 'status', 'published_on', 'closed_on',
    'applies', 'dispositions', 'posting_id',
  ],
  hrm_retention_runs: [
    'rule', 'ran_at', 'anonymized', 'deleted', 'extensions', 'run_id',
  ],
  hrm_pool_members: ['pool', 'candidate', 'added_on', 'note'],
}

test('every locale carries the recruiting-depth surface keys with en placeholder parity', () => {
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

test('every locale catalogs the recruiting-depth report entities with their columns', () => {
  for (const locale of LOCALES) {
    const catalog = load(locale, 'reports.json')['catalog'] as Dict
    const entities = catalog['entities'] as Dict
    const columns = catalog['columns'] as Dict
    for (const [entity, want] of Object.entries(REPORT_COLUMNS)) {
      const entry = entities[entity] as Dict | undefined
      assert.ok(entry, `${locale} reports.json lacks catalog.entities.${entity} — the report hub cannot describe the entity`)
      assert.equal(typeof entry['label'], 'string', `${locale} reports.json ${entity} entity lacks a label`)
      assert.equal(typeof entry['description'], 'string', `${locale} reports.json ${entity} entity lacks a description`)
      const mirrored = columns[entity] as Dict | undefined
      assert.ok(mirrored, `${locale} reports.json lacks catalog.columns.${entity}`)
      assert.deepStrictEqual(
        Object.keys(mirrored ?? {}).sort(),
        [...want].sort(),
        `${locale} reports.json catalog.columns.${entity} drifts from the entity definition`,
      )
    }
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { displayAccountStatusName, displayOpportunityStatusName, SEEDED_ACCOUNT_STATUS_NAMES, SEEDED_OPPORTUNITY_STATUS_NAMES } from './crm-status-display.ts'

const here = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(here, '..', 'messages')
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'crm.json'), 'utf8'))

// F-x6-001 item 4: the opp drawer title pill rendered the DB-seeded English
// status name ("Closed lost") under fr. Unrenamed seed statuses render via
// the catalog; a renamed (custom) status keeps its stored name.
test('seeded status names resolve through the translator', () => {
  const t = (key: string) => `<${key}>`
  assert.equal(displayOpportunityStatusName('Closed lost', t), '<closedLost>')
  assert.equal(displayOpportunityStatusName('Qualification', t), '<qualification>')
  assert.equal(displayOpportunityStatusName('Closed won', t), '<closedWon>')
})

test('renamed or unknown statuses keep their stored name', () => {
  const t = (key: string) => `<${key}>`
  assert.equal(displayOpportunityStatusName('Perdue — abandon', t), 'Perdue — abandon')
  assert.equal(displayOpportunityStatusName('Whatever', t), 'Whatever')
})

for (const locale of ['en', 'fr', 'es']) {
  test(`F-x6-001: opportunity status names are translated in ${locale}`, () => {
    const statuses = (catalog(locale).opportunities as Record<string, unknown>).statuses as
      | Record<string, unknown>
      | undefined
    assert.ok(statuses, `${locale} opportunities.statuses must exist`)
    for (const key of Object.values(SEEDED_OPPORTUNITY_STATUS_NAMES)) {
      assert.equal(typeof statuses[key], 'string', `${locale} statuses.${key} must be translated`)
    }
  })
}

test('the seeded-name map matches the engine provisioning seed', () => {
  const seed = readFileSync(join(here, '..', '..', 'engine', 'src', 'crm.ts'), 'utf8')
  const block = seed.match(/DEFAULT_OPPORTUNITY_STATUSES = \[([\s\S]*?)\] as const/)
  assert.ok(block, 'engine must declare DEFAULT_OPPORTUNITY_STATUSES')
  const names = [...block[1]!.matchAll(/\[\s*"[^"]+",\s*"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(new Set(Object.keys(SEEDED_OPPORTUNITY_STATUS_NAMES)), new Set(names))
})

// F-x6-002: account statuses share the opportunity-status pattern —
// DB-seeded English names rendered raw in the account drawer select.
test('seeded account status names resolve through the translator', () => {
  const t = (key: string) => `<${key}>`
  assert.equal(displayAccountStatusName('Nurturing', t), '<nurturing>')
  assert.equal(displayAccountStatusName('Closed lost', t), '<closedLost>')
  assert.equal(displayAccountStatusName('Deprecated stage', t), 'Deprecated stage')
})

for (const locale of ['en', 'fr', 'es']) {
  test(`F-x6-002: account status names are translated in ${locale}`, () => {
    const statuses = (catalog(locale).accounts as Record<string, unknown>).statuses as
      | Record<string, unknown>
      | undefined
    assert.ok(statuses, `${locale} accounts.statuses must exist`)
    for (const key of Object.values(SEEDED_ACCOUNT_STATUS_NAMES)) {
      assert.equal(typeof statuses[key], 'string', `${locale} accounts.statuses.${key} must be translated`)
    }
  })
}

test('the account seeded-name map matches the engine provisioning seed', () => {
  const seed = readFileSync(join(here, '..', '..', 'engine', 'src', 'crm.ts'), 'utf8')
  const block = seed.match(/DEFAULT_ACCOUNT_STATUSES = \[([\s\S]*?)\] as const/)
  assert.ok(block, 'engine must declare DEFAULT_ACCOUNT_STATUSES')
  const names = [...block[1]!.matchAll(/\[\s*"[^"]+",\s*"[^"]+",\s*"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(new Set(Object.keys(SEEDED_ACCOUNT_STATUS_NAMES)), new Set(names))
})

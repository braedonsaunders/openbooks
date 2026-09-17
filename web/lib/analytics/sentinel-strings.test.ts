import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  auditEventArgs,
  englishSentinelStrings,
  sentinelStrings,
} from './sentinel-strings.ts'

test('audit summaries assemble from action, actor, resource and changed fields (F-t09-006)', () => {
  assert.deepEqual(
    auditEventArgs('update', 'a1b2c3d4-ffff', 'parties', '9f8e7d6c-ffff', '{"email":"a@b.c","phone":"1"}'),
    { verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email, phone' },
  )
  assert.deepEqual(
    auditEventArgs('DELETE', null, 'bank_accounts', '12345678-ffff', ''),
    { verb: 'deleted', action: 'delete', actor: 'system', table: 'bank_accounts', row: '12345678', fields: '' },
  )
  // Truncated envelopes (the loader caps at 200 chars) name no fields
  // rather than failing the row.
  assert.equal(auditEventArgs('update', 'a1b2c3d4', 'parties', '9f8e7d6c', '{"email":').fields, '')
  // Long field lists truncate with an ellipsis marker, never raw JSON.
  assert.equal(
    auditEventArgs('insert', 'a1b2c3d4', 'parties', '9f8e7d6c', '{"a":1,"b":2,"c":3,"d":4}').fields,
    'a, b, c, …',
  )
  // Unmapped actions pass through as data under the stable `other` verb.
  assert.deepEqual(
    auditEventArgs('Void', 'a1b2c3d4', 'documents', '9f8e7d6c', null).verb,
    'other',
  )
})

/**
 * Sentinel forensic sentences resolve through the message catalogs.
 * Benford messages, flag reasons, risk-area copy and the unknown-party label
 * were hardcoded English in sentinel-data.ts. Conformity itself is a stable
 * code (excellent/acceptable/marginal/nonConforming) in every language.
 */

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

test('the English default pins the exact legacy sentences', () => {
  const s = englishSentinelStrings
  assert.equal(s.benfordInsufficient(7), 'Insufficient data (7 transactions). Need at least 50.')
  assert.equal(s.trapReason('9999'), 'Amount ends in 9999 (potential threshold avoidance)')
  assert.equal(s.weekendReason(true), 'Dated on Sunday')
  assert.equal(s.rsfReason('12.5', 'Acme', 'CAD'), "12.5× larger than Acme's historical 2nd largest (CAD)")
  assert.equal(s.zscoreReason('4.10', 'Acme', 'CAD', 8), 'Z-score 4.10 vs Acme CAD average (8 transactions)')
  assert.equal(
    s.sequentialReason(5, '100', '104', 12, true, 'CAD'),
    '5 gap-free sequential CAD invoices (100–104) over 12 days — possible shell company / sole customer',
  )
  assert.equal(
    s.ghostBoth('V', 'E'),
    'Vendor "V" matches employee "E" by BOTH name and street address',
  )
  assert.equal(
    s.duplicateGroupReason({ count: 2, currency: 'CAD', amount: '5000', sharedReference: null, daysSpan: 2, others: 'DUP-2' }),
    '2 matching documents — same vendor, kind, amount (CAD 5000) (2 days span): DUP-2',
  )
  assert.deepEqual(s.riskGhosts(2), { area: 'Ghost Vendors', message: '2 vendors match employee names' })
  assert.deepEqual(s.riskDuplicates(11), { area: 'Duplicate Payments', message: '11 duplicate groups (one finding per group)' })
  assert.deepEqual(s.riskDuplicates(1), { area: 'Duplicate Payments', message: '1 duplicate group (one finding per group)' })
  assert.equal(s.displayPartyName('Unknown'), 'Unknown')
  assert.equal(s.displayPartyName(''), 'Unknown')
  assert.equal(s.displayPartyName('Acme'), 'Acme')
  assert.equal(
    s.auditEvent({ verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email, phone' }),
    'a1b2c3d4 updated parties 9f8e7d6c (email, phone)',
  )
  assert.equal(
    s.auditEvent({ verb: 'deleted', action: 'delete', actor: 'system', table: 'bank_accounts', row: '12345678', fields: '' }),
    'system deleted bank_accounts 12345678',
  )
  assert.equal(
    s.auditEvent({ verb: 'other', action: 'void', actor: 'a1b2c3d4', table: 'documents', row: '9f8e7d6c', fields: '' }),
    'a1b2c3d4 void documents 9f8e7d6c',
  )
})

test('the French catalog renders French forensics with ICU plurals', () => {
  const s = sentinelStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.benfordInsufficient(1), 'Données insuffisantes (1 transaction). 50 minimum.')
  assert.equal(s.benfordInsufficient(7), 'Données insuffisantes (7 transactions). 50 minimum.')
  assert.equal(s.weekendReason(false), 'Comptabilisé un samedi')
  assert.equal(s.zscoreReason('4.10', 'Acme', 'CAD', 1), 'Z-score 4.10 vs moyenne CAD de Acme (1 transaction)')
  assert.equal(
    s.sequentialReason(1, '100', '100', 1, false, 'CAD'),
    '1 facture séquentielle CAD sans trou (100–100) sur 1 jour',
  )
  assert.equal(
    s.duplicateGroupReason({ count: 2, currency: 'CAD', amount: '5000', sharedReference: null, daysSpan: 2, others: 'DUP-2' }),
    '2 documents correspondants — même fournisseur, nature et montant (CAD 5000) (écart de 2 jours) : DUP-2',
  )
  assert.deepEqual(s.riskGhosts(2), { area: 'Fournisseurs fantômes', message: '2 fournisseurs correspondent à des salariés' })
  assert.equal(s.displayPartyName('Unknown'), 'Inconnu')
  assert.equal(
    s.auditEvent({ verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email, phone' }),
    'a1b2c3d4 a mis à jour parties 9f8e7d6c (email, phone)',
  )
})

test('the English default is byte-identical to the en catalog rendering', () => {
  const def = englishSentinelStrings
  const en = sentinelStrings(catalogTranslator('en'), 'en')
  const cases: Array<[string, (s: typeof en) => unknown]> = [
    ['insufficient-1', (s) => s.benfordInsufficient(1)],
    ['insufficient-7', (s) => s.benfordInsufficient(7)],
    ['close', (s) => s.benfordClose],
    ['reasonable', (s) => s.benfordReasonable],
    ['someDeviation', (s) => s.benfordSomeDeviation],
    ['significant', (s) => s.benfordSignificant],
    ['trap', (s) => s.trapReason('9999')],
    ['weekend-sat', (s) => s.weekendReason(false)],
    ['weekend-sun', (s) => s.weekendReason(true)],
    ['rsf', (s) => s.rsfReason('12.5', 'Acme', 'CAD')],
    ['zscore-1', (s) => s.zscoreReason('4.10', 'Acme', 'CAD', 1)],
    ['zscore-8', (s) => s.zscoreReason('4.10', 'Acme', 'CAD', 8)],
    ['sequential-1', (s) => s.sequentialReason(1, '100', '100', 1, false, 'CAD')],
    ['sequential-5', (s) => s.sequentialReason(5, '100', '104', 12, true, 'CAD')],
    ['ghostBoth', (s) => s.ghostBoth('V', 'E')],
    ['ghostAddress', (s) => s.ghostAddress('V', 'E')],
    ['ghostName', (s) => s.ghostName('V', 'E')],
    ['dup-1-noref', (s) => s.duplicateGroupReason({ count: 1, currency: 'CAD', amount: '5000', sharedReference: null, daysSpan: 1, others: 'DUP-2' })],
    ['dup-2-ref', (s) => s.duplicateGroupReason({ count: 2, currency: 'CAD', amount: '5000', sharedReference: 'PO-1', daysSpan: 2, others: 'DUP-2' })],
    ['riskGhosts-1', (s) => s.riskGhosts(1)],
    ['riskGhosts-2', (s) => s.riskGhosts(2)],
    ['riskSequential-1', (s) => s.riskSequential(1)],
    ['riskDuplicates-1', (s) => s.riskDuplicates(1)],
    ['riskDuplicates-11', (s) => s.riskDuplicates(11)],
    ['riskTraps-1', (s) => s.riskTraps(1)],
    ['riskTraps-3', (s) => s.riskTraps(3)],
    ['riskBenford', (s) => s.riskBenford()],
    ['unknown', (s) => s.displayPartyName('Unknown')],
    ['blank', (s) => s.displayPartyName('')],
    ['named', (s) => s.displayPartyName('Acme')],
    ['audit-updated', (s) => s.auditEvent({ verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email, phone' })],
    ['audit-deleted-nofields', (s) => s.auditEvent({ verb: 'deleted', action: 'delete', actor: 'system', table: 'bank_accounts', row: '12345678', fields: '' })],
    ['audit-other', (s) => s.auditEvent({ verb: 'other', action: 'void', actor: 'a1b2c3d4', table: 'documents', row: '9f8e7d6c', fields: '' })],
  ]
  for (const [name, run] of cases) {
    assert.deepEqual(run(def), run(en), `${name}: default must equal en catalog rendering`)
  }
})

test('every locale renders the forensics without falling back to English', () => {
  const en = sentinelStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = sentinelStrings(catalogTranslator(locale), locale)
    for (const [name, got, want] of [
      ['benfordInsufficient', s.benfordInsufficient(7), en.benfordInsufficient(7)],
      ['trap', s.trapReason('9999'), en.trapReason('9999')],
      ['rsf', s.rsfReason('12.5', 'Acme', 'CAD'), en.rsfReason('12.5', 'Acme', 'CAD')],
      ['sequential', s.sequentialReason(5, '100', '104', 12, true, 'CAD'), en.sequentialReason(5, '100', '104', 12, true, 'CAD')],
      ['duplicate', s.duplicateGroupReason({ count: 2, currency: 'CAD', amount: '5000', sharedReference: null, daysSpan: 2, others: 'DUP-2' }), en.duplicateGroupReason({ count: 2, currency: 'CAD', amount: '5000', sharedReference: null, daysSpan: 2, others: 'DUP-2' })],
      ['riskGhosts', s.riskGhosts(2).message, en.riskGhosts(2).message],
      ['audit', s.auditEvent({ verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email' }), en.auditEvent({ verb: 'updated', action: 'update', actor: 'a1b2c3d4', table: 'parties', row: '9f8e7d6c', fields: 'email' })],
    ] as const) {
      assert.notEqual(got, want, `${locale} ${name} must not be English fallback`)
    }
  }
})

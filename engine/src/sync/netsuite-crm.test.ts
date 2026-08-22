import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isNetSuiteRecentActivityEmail,
  normalizeNetSuiteRecentActivityNote,
  resolveNetSuiteCrmCurrency,
} from './netsuite-crm.ts'

const crmSource = readFileSync(new URL('./netsuite-crm.ts', import.meta.url), 'utf8')

test('recent-activity upserts pin the known tenant on the id conflict write', () => {
  assert.match(
    crmSource,
    /on conflict\(id\) do update set[\s\S]*?where crm_activities\.org_id=\$\{orgId\}/,
  )
})

test('maps typed recent-activity notes into sales visits and account links', () => {
  const visit = normalizeNetSuiteRecentActivityNote({
    id: '1845',
    entity: '3028',
    type: 'Note : 9',
    typecode: 'Note : 9',
    createddate: '05/03/2024',
    details: 'Note - 2024-05-03 09:30am',
    subdetails: 'Meeting at the plant. Went on a site tour and left rate sheets.',
  })
  assert.ok(visit)
  assert.equal(visit.kind, 'event')
  assert.equal(visit.accountSourceId, '3028')
  assert.equal(visit.occurredAt, '2024-05-03')
  assert.equal(visit.subject, 'Meeting at the plant. Went on a site tour and left rate sheets.')
  assert.equal(visit.metadata.recordType, 'recentActivityNote')
  assert.equal(visit.metadata.sourceType, 'Note : 9')
})

test('classifies calls and notes while excluding email activity', () => {
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '1', typecode: 'Note : 8', subdetails: 'Called and left a VM.' })?.kind, 'call')
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '2', typecode: 'Note : ', subdetails: 'General account context.' })?.kind, 'note')
  const email = { id: '3', typecode: 'Note : 3', subdetails: 'Emailed to follow up.' }
  assert.equal(isNetSuiteRecentActivityEmail(email), true)
  assert.equal(normalizeNetSuiteRecentActivityNote(email), null)
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '4', typecode: 'Note : 9', subdetails: 'Site visit after an email introduction.' })?.kind, 'event')
})

test('resolves opportunity currencies through configured ISO currencies', () => {
  const sourceCurrencies = new Map([['1', 'CAD'], ['2', 'USD']])
  const configuredCurrencies = new Set(['CAD', 'USD'])
  assert.equal(resolveNetSuiteCrmCurrency('2', 'CAD', sourceCurrencies, configuredCurrencies), 'USD')
  assert.equal(resolveNetSuiteCrmCurrency(null, 'CAD', sourceCurrencies, configuredCurrencies), 'CAD')
  assert.equal(resolveNetSuiteCrmCurrency('EUR', 'CAD', sourceCurrencies, configuredCurrencies), null)
  assert.equal(resolveNetSuiteCrmCurrency('not-a-currency', 'CAD', sourceCurrencies, configuredCurrencies), null)
})

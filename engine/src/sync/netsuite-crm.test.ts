import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeNetSuiteMessage, normalizeNetSuiteRecentActivityNote, resolveNetSuiteCrmCurrency } from './netsuite-crm.ts'

test('normalizes an HTML source email with direction, links, and participants', () => {
  const message = normalizeNetSuiteMessage({
    id: '230',
    messagetype: 'EMAIL',
    subject: 'Site visit follow-up',
    message: '<p>Thanks &amp; see the attached report.</p><p>Next visit: Friday.</p>',
    htmlmessage: 'T',
    emailed: 'T',
    incoming: 'F',
    messagedate: '11/25/2025',
    time: '08:32 am',
    entity: '107',
    relatedentity: '107',
    transaction: '991',
    author: '12',
    authoremail: 'Sales@Example.com',
    recipient: '45',
    recipientemail: 'buyer@example.com',
    cc: 'ops@example.com; BUYER@example.com',
    bcc: 'audit@example.com',
    hasattachment: true,
  })

  assert.ok(message)
  assert.equal(message.kind, 'email')
  assert.equal(message.body, 'Thanks & see the attached report.\nNext visit: Friday.')
  assert.equal(message.occurredAt, '2025-11-25T08:32:00Z')
  assert.equal(message.accountSourceId, '107')
  assert.equal(message.opportunitySourceId, '991')
  assert.equal(message.authorSourceId, '12')
  assert.equal(message.recipientSourceId, '45')
  assert.deepEqual(message.participantEmails, [
    'sales@example.com',
    'buyer@example.com',
    'ops@example.com',
    'audit@example.com',
  ])
  assert.deepEqual(
    {
      incoming: message.metadata.incoming,
      hasAttachment: message.metadata.hasAttachment,
      recordType: message.metadata.recordType,
      sourceType: message.metadata.sourceType,
    },
    { incoming: false, hasAttachment: true, recordType: 'message', sourceType: 'EMAIL' },
  )
})

test('uses source message type to preserve calls, visits, tasks, and notes', () => {
  assert.equal(normalizeNetSuiteMessage({ id: '1', messagetype: 'PHONE CALL', subject: 'Call' })?.kind, 'call')
  assert.equal(normalizeNetSuiteMessage({ id: '2', messagetype: 'SALES VISIT', subject: 'Visit' })?.kind, 'event')
  assert.equal(normalizeNetSuiteMessage({ id: '3', messagetype: 'TASK', subject: 'Follow up' })?.kind, 'task')
  assert.equal(normalizeNetSuiteMessage({ id: '4', messagetype: 'NOTE', subject: 'Context' })?.kind, 'note')
})

test('falls back to body text for the subject and rejects content-free messages', () => {
  const message = normalizeNetSuiteMessage({ id: '5', message: 'A useful note without a subject.' })
  assert.ok(message)
  assert.equal(message.subject, 'A useful note without a subject.')
  assert.equal(normalizeNetSuiteMessage({ id: '6', subject: ' ', message: ' ' }), null)
  assert.equal(normalizeNetSuiteMessage({ id: '', subject: 'No source identity' }), null)
})

test('keeps the source date when its time value cannot be parsed safely', () => {
  assert.equal(
    normalizeNetSuiteMessage({ id: '7', subject: 'Imported', messagedate: '07/17/2026', time: 'account-local' })?.occurredAt,
    '2026-07-17',
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

test('classifies legacy note narratives without discarding their source type', () => {
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '1', typecode: 'Note : 8', subdetails: 'Called and left a VM.' })?.kind, 'call')
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '2', typecode: 'Note : 3', subdetails: 'Emailed to follow up.' })?.kind, 'email')
  assert.equal(normalizeNetSuiteRecentActivityNote({ id: '3', typecode: 'Note : ', subdetails: 'General account context.' })?.kind, 'note')
})

test('resolves opportunity currencies through configured ISO currencies', () => {
  const sourceCurrencies = new Map([['1', 'CAD'], ['2', 'USD']])
  const configuredCurrencies = new Set(['CAD', 'USD'])
  assert.equal(resolveNetSuiteCrmCurrency('2', 'CAD', sourceCurrencies, configuredCurrencies), 'USD')
  assert.equal(resolveNetSuiteCrmCurrency(null, 'CAD', sourceCurrencies, configuredCurrencies), 'CAD')
  assert.equal(resolveNetSuiteCrmCurrency('EUR', 'CAD', sourceCurrencies, configuredCurrencies), null)
  assert.equal(resolveNetSuiteCrmCurrency('not-a-currency', 'CAD', sourceCurrencies, configuredCurrencies), null)
})

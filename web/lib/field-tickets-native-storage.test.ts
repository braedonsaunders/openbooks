import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runtimeFiles = [
  'web/lib/field-tickets.ts',
  'web/lib/field-ticket-signing.ts',
  'web/app/api/field-tickets/route.ts',
  'web/app/api/field-tickets/[id]/route.ts',
  'web/app/api/sign/field-tickets/route.ts',
  'web/app/(app)/field-tickets/page.tsx',
  'web/lib/list/sources.ts',
  'engine/src/flows/field-tickets-adapter.ts',
]

test('native Field Ticket runtime never persists product state in custom JSON', () => {
  for (const path of runtimeFiles) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /custom\s*(?:\.|->)\s*['"]?fieldTicket/i, path)
    assert.doesNotMatch(source, /fieldTicketPeriod/i, path)
  }
})

test('source importer cannot infer ticket lineage from matching time values', () => {
  const source = readFileSync('engine/src/validation/import-field-tickets.ts', 'utf8')
  assert.doesNotMatch(source, /update\s+time_entries[\s\S]*field_ticket_id/i)
  assert.doesNotMatch(source, /abs\s*\(\s*te\.hours/i)
  assert.match(source, /link-field-ticket-time-by-source\.ts/)
})

test('customer-sign endpoint keeps signature capture causally atomic', () => {
  const source = readFileSync('web/app/api/sign/field-tickets/route.ts', 'utf8')
  assert.match(source, /withOrgTransaction\s*\(/, 'signing must stay inside one org transaction')
  assert.match(source, /pg_advisory_xact_lock/, 'concurrent signers are serialized')
  assert.match(source, /uploadAndAttach\s*\(/, 'signature evidence uses cabinet primitives')
  assert.match(source, /validateSigningRequest\(/, 'the persisted request is revalidated inside the transaction')
})

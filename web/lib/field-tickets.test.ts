import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tickets = readFileSync(new URL('./field-tickets.ts', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('./field-ticket-drawer-data.ts', import.meta.url), 'utf8')

test('field-ticket detail and picker data carry one canonical legal entity boundary', () => {
  assert.match(tickets, /d\.subsidiary_id as "subsidiaryId"/)
  assert.match(tickets, /subsidiaryId: doc\.subsidiaryId/)
  assert.match(tickets, /opts\.allowedSubsidiaryIds !== undefined/)
  assert.match(tickets, /p\.subsidiary_id/)
  assert.match(tickets, /dl\.subsidiary_id/)
  assert.match(drawer, /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/)
  assert.match(drawer, /p\.subsidiary_id/)
  assert.match(drawer, /subsidiary_id/)
})

test('item line changes are revision-fenced, parent-locked and atomic', () => {
  assert.ok((tickets.match(/for update of d, ft/g) ?? []).length >= 2)
  assert.ok((tickets.match(/runDocumentVersionedTransaction</g) ?? []).length >= 4)
  assert.match(tickets, /expectedRevision: string,\n  allowedSubsidiaryIds/)
  assert.match(tickets, /insert into charge_rate_components/)
  assert.match(tickets, /delete from charge_rate_components/)
  assert.match(tickets, /updated_at = greatest\(clock_timestamp\(\), d\.updated_at \+ interval '1 microsecond'\)/)
  // Both line operations verify ownership before touching component evidence;
  // a guessed line id can never delete another ticket's rate components.
  assert.match(tickets, /select id from document_lines[\s\S]*document_id = \$\{ticketId\}/)
})

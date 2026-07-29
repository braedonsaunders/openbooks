import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(path, 'utf8')

test('Field Ticket billing selections use an immutable tenant-scoped relation', () => {
  const schema = source('schema/src/billing.ts')
  const migration = source('schema/migrations/generated/0089_field_ticket_billing_lineage.sql')
  const requests = source('web/lib/billing-requests.ts')

  assert.match(schema, /enum: \["date_range", "draw_amount", "time_selection", "milestone", "field_ticket"\]/)
  assert.match(schema, /billingRequestFieldTickets = pgTable/)
  assert.match(schema, /billing_request_field_tickets_request_ticket/)

  assert.match(migration, /CREATE TABLE IF NOT EXISTS billing_request_field_tickets/)
  assert.match(migration, /selection_source IN \('request_creation', 'legacy_json_migration', 'validation_replay'\)/)
  assert.match(migration, /custom = custom - 'fieldTicketIds'/)
  assert.match(migration, /billing_requests_no_field_ticket_ids_json/)
  assert.match(migration, /billing request Field Ticket selections are immutable/)
  assert.match(migration, /CREATE CONSTRAINT TRIGGER billing_request_field_ticket_request_guard/)
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
  assert.match(migration, /ticket\.org_id = new\.org_id/)
  assert.match(migration, /ticket\.project_id = request_project_id/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/)

  assert.match(requests, /insert into billing_request_field_tickets/)
  assert.match(requests, /'request_creation'/)
  assert.match(requests, /ticket\.status = 'approved'/)
  assert.match(requests, /request\.status <> 'cancelled'/)
  assert.match(requests, /pg_advisory_xact_lock/)
  assert.doesNotMatch(requests, /custom\s*(?:\.|->).*fieldTicketIds/)
})

test('Field Ticket charges and invoices preserve document and line provenance', () => {
  const tickets = source('web/lib/field-tickets.ts')
  const charges = source('web/lib/project-charges.ts')
  const billing = source('web/lib/billing.ts')
  const migration = source('schema/migrations/generated/0089_field_ticket_billing_lineage.sql')

  assert.match(tickets, /fieldTicketId: ticketId/)
  assert.match(tickets, /field_ticket_id, created_by, updated_by/)
  assert.match(charges, /fieldTicketId\?: string \| null/)
  assert.match(charges, /field_ticket_id, created_by/)
  assert.match(charges, /The source Field Ticket does not belong to this project/)

  assert.match(billing, /from billing_request_field_tickets/)
  assert.match(billing, /const selectedFieldTicketIds/)
  assert.match(billing, /dl\.field_ticket_id = any/)
  assert.match(billing, /insert into document_links/)
  assert.match(billing, /'bills'/)
  assert.doesNotMatch(billing, /custom\s*(?:\.|->).*fieldTicketIds/)

  assert.match(migration, /SET field_ticket_id = ticket\.id/)
  assert.match(migration, /document_links_unique_edge/)
})

test('Field Ticket billing is feature-gated and visible in project and ticket workflows', () => {
  const cockpit = source('web/app/(app)/projects/_cockpit-data.ts')
  const billingUi = source('web/app/(app)/projects/tabs/BillingSection.tsx')
  const ticketUi = source('web/app/(app)/field-tickets/FieldTicketDrawer.tsx')
  const setupRoute = source('web/app/api/admin/setup/project-types/route.ts')
  const replay = source('engine/src/validation/ft-batch-replay.ts')

  assert.match(cockpit, /isFeatureEnabled\(orgId, 'fieldTickets'\)/)
  assert.match(cockpit, /listBillableFieldTickets/)
  assert.match(billingUi, /selectedFieldTicketIds/)
  assert.match(billingUi, /fieldTicketIds: basis === 'field_ticket'/)
  assert.match(billingUi, /noBillableFieldTickets/)
  assert.match(ticketUi, /key: 'related'/)
  assert.match(ticketUi, /ticket\.billingRequests/)
  assert.match(ticketUi, /ticket\.links/)
  assert.match(setupRoute, /Company Settings → Features/)

  assert.match(replay, /insert into billing_request_field_tickets/)
  assert.match(replay, /'validation_replay'/)
  assert.doesNotMatch(replay, /JSON\.stringify\(\{\s*fieldTicketIds/)
})

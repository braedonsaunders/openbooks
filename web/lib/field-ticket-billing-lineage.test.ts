import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(path, 'utf8')

test('Field Ticket billing selections use an immutable tenant-scoped relation', () => {
  const schema = source('schema/src/billing.ts')
  const baseline = source('schema/migrations/generated/0001_baseline.sql')
  const requests = source('web/lib/billing-requests.ts')

  assert.match(schema, /enum: \["date_range", "draw_amount", "time_selection", "milestone", "field_ticket"\]/)
  assert.match(schema, /billingRequestFieldTickets = pgTable/)
  assert.match(schema, /billing_request_field_tickets_request_ticket/)

  assert.match(baseline, /CREATE TABLE public\.billing_request_field_tickets/)
  assert.doesNotMatch(baseline, /selection_source/)
  assert.match(baseline, /billing request Field Ticket selections are immutable/)
  assert.match(baseline, /ticket\.org_id = new\.org_id/)
  assert.match(baseline, /ticket\.project_id = request_project_id/)
  assert.match(baseline, /ticket\.status = 'approved'/)
  assert.match(baseline, /ALTER TABLE public\.billing_request_field_tickets ENABLE ROW LEVEL SECURITY/)
  assert.match(baseline, /ALTER TABLE ONLY public\.billing_request_field_tickets FORCE ROW LEVEL SECURITY/)

  assert.match(requests, /insert into billing_request_field_tickets/)
  assert.match(requests, /ticket\.status = 'approved'/)
  assert.match(requests, /request\.status <> 'cancelled'/)
  assert.match(requests, /pg_advisory_xact_lock/)
  assert.doesNotMatch(requests, /custom\s*(?:\.|->).*fieldTicketIds/)
})

test('Field Ticket charges and invoices preserve document and line provenance', () => {
  const tickets = source('web/lib/field-tickets.ts')
  const charges = source('web/lib/project-charges.ts')
  const billing = source('web/lib/billing.ts')
  const baseline = source('schema/migrations/generated/0001_baseline.sql')

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

  assert.match(baseline, /field_ticket_id uuid/)
  assert.match(baseline, /document_links_unique_edge/)
})

test('Field Ticket billing is feature-gated and visible in project and ticket workflows', () => {
  const cockpit = source('web/app/(app)/projects/_cockpit-data.ts')
  const billingUi = source('web/app/(app)/projects/tabs/BillingSection.tsx')
  const ticketUi = source('web/app/(app)/field-tickets/FieldTicketDrawer.tsx')
  const setupRoute = source('web/app/api/admin/setup/project-types/route.ts')

  assert.match(cockpit, /isFeatureEnabled\(orgId, 'fieldTickets'\)/)
  assert.match(cockpit, /listBillableFieldTickets/)
  assert.match(billingUi, /selectedFieldTicketIds/)
  assert.match(billingUi, /fieldTicketIds: basis === 'field_ticket'/)
  assert.match(billingUi, /noBillableFieldTickets/)
  assert.match(ticketUi, /key: 'related'/)
  assert.match(ticketUi, /ticket\.billingRequests/)
  assert.match(ticketUi, /ticket\.links/)
  assert.match(setupRoute, /Company Settings → Features/)
})

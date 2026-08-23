import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('WIP schema separates review snapshots, source holds, and append-only evidence', () => {
  const schema = source('../schema/src/wip-billing.ts')

  assert.match(schema, /wipPrebills = pgTable/)
  assert.match(schema, /enum: \["draft", "review", "approved", "converted", "void"\]/)
  assert.match(schema, /wipPrebillLines = pgTable/)
  assert.match(schema, /timeEntryId: uuid\("time_entry_id"\)/)
  assert.match(schema, /documentLineId: uuid\("document_line_id"\)/)
  assert.match(schema, /adjustmentEvidence: jsonb/)
  assert.match(schema, /wipHolds = pgTable/)
  assert.match(schema, /releasedAt: timestamp/)
  assert.match(schema, /wipPrebillEvents = pgTable/)
  assert.doesNotMatch(schema, /wip_invoices|prebill_invoices/)
})

test('WIP service reserves eligible work and governs supported billing adjustments', () => {
  const service = source('lib/wip-billing.ts')

  assert.match(service, /pg_advisory_xact_lock\(hashtextextended\(\$\{`wip-prebill:/)
  assert.match(service, /te\.status = 'approved'/)
  assert.match(service, /te\.billing_status = 'unbilled'/)
  assert.match(service, /line\.billed_by_line_id is null/)
  assert.match(service, /worksheet\.status in \('draft', 'review', 'approved'\)/)
  assert.match(service, /effectiveWipPolicy/)
  assert.match(service, /sourceLinePrebillingReason/)
  assert.match(service, /remainingContractCapacity/)
  assert.match(service, /pricing_snapshot/)
  assert.match(service, /Only a draft prebill can be edited/)
  assert.match(service, /A reason is required for a write-up or write-down/)
  assert.match(service, /Evidence is required for a write-up or write-down/)
  assert.match(service, /Every write-up and write-down requires a reason and evidence/)
  assert.match(service, /canonicalDecimal\(value, 4\)/)
  assert.match(service, /normalizeMoney\(exact\)/)
  assert.match(service, /persistMoney\(input\.proposedBillAmount/)
})

test('WIP conversion is retry-safe, rejects held sources, and stamps exact native provenance', () => {
  const service = source('lib/wip-billing.ts')

  assert.match(service, /status === 'converted'.*invoice_id/s)
  assert.match(service, /for update of worksheet/)
  assert.match(service, /Release all billing holds before conversion/)
  assert.match(service, /insert into billing_requests/)
  assert.match(service, /insert into documents/)
  assert.match(service, /'customer_invoice'/)
  assert.match(service, /insert into document_lines/)
  assert.match(service, /billing_status = 'billed'/)
  assert.match(service, /billed_by_line_id = \$\{invoiceLineId\}/)
  assert.match(service, /and billing_status = 'unbilled'/)
  assert.match(service, /and billed_by_line_id is null/)
  assert.match(service, /status = 'converted', billing_request_id/)
})

test('WIP API permissions and feature gates separate preparation, approval, and conversion', () => {
  const collection = source('app/api/wip-billing/route.ts')
  const item = source('app/api/wip-billing/[id]/route.ts')
  const convert = source('app/api/wip-billing/[id]/convert/route.ts')
  const line = source('app/api/wip-billing/[id]/lines/[lineId]/route.ts')
  const gate = source('lib/wip-billing-gate.ts')

  assert.match(collection, /guardPermission\('projects\.read'\)/)
  assert.match(collection, /guardPermission\('projects\.manage'\)/)
  assert.match(item, /body\?\.action === 'approve' \? 'ar\.approve'/)
  assert.match(convert, /guardPermission\('ar\.create'\)/)
  assert.match(line, /guardPermission\('projects\.manage'\)/)
  assert.match(gate, /isFeatureEnabled\(orgId, 'projects'\)/)
  assert.match(gate, /isFeatureEnabled\(orgId, 'wipBilling'\)/)
})

test('WIP workspace exposes aging, realization, leakage, holds, workflow, and invoices', () => {
  const page = source('app/(app)/projects/wip-billing/page.tsx')
  const workspace = source('app/(app)/projects/wip-billing/WipBillingWorkspace.tsx')
  const messages = JSON.parse(source('messages/en/projects.json')) as {
    wipBilling: {
      wipHealthAria: string
      tiles: { realization: string; leakage: string }
      detail: { sendForReview: string; approve: string; createInvoice: string }
      lockedAlert: string
      line: { hold: string; releaseHold: string }
    }
  }
  const { wipBilling } = messages

  assert.match(page, /requireWipBillingFeature/)
  assert.match(page, /wipAnalytics/)
  assert.match(workspace, /t\("wipHealthAria"\)/)
  assert.equal(wipBilling.wipHealthAria, 'WIP health')
  assert.match(workspace, /t\("tiles\.realization"\)/)
  assert.equal(wipBilling.tiles.realization, 'Realization')
  assert.match(workspace, /t\("tiles\.leakage"\)/)
  assert.equal(wipBilling.tiles.leakage, 'Leakage')
  assert.match(workspace, /t\("detail\.sendForReview"\)/)
  assert.equal(wipBilling.detail.sendForReview, 'Send for review')
  assert.match(workspace, /t\("detail\.approve"\)/)
  assert.equal(wipBilling.detail.approve, 'Approve')
  assert.match(workspace, /t\("detail\.createInvoice"\)/)
  assert.equal(wipBilling.detail.createInvoice, 'Create invoice')
  assert.match(workspace, /t\("line\.hold"\)/)
  assert.equal(wipBilling.line.hold, 'Hold')
  assert.match(workspace, /t\("line\.releaseHold"\)/)
  assert.equal(wipBilling.line.releaseHold, 'Release hold')
  assert.match(workspace, /t\("lockedAlert"\)/)
  assert.match(wipBilling.lockedAlert, /approval snapshot is locked/i)
  assert.match(workspace, /<EmptyState/)
  assert.doesNotMatch(workspace, /window\.prompt/)
  assert.doesNotMatch(workspace, /1–30 days/)
  assert.match(workspace, /lg:grid-cols-4/)
})

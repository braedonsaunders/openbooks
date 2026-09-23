import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { generateInvoiceFromBillingRequest, BillingError } from '../../../../../lib/billing'
import { assembleInvoiceBackup, type BackupType } from '../../../../../lib/invoice-backup'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const runtime = 'nodejs'

/** Generate a draft customer_invoice from an open billing request. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const result = await generateInvoiceFromBillingRequest(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds)
    // A backup-required request leaves the draft with its packet already
    // assembled, so the download link works and the later issue gate finds
    // its evidence. Assembly runs after the invoice transaction commits —
    // never rendered inside it — and a failure here stays retryable: the
    // draft stands, and issuing refuses until the packet exists.
    if (result.backupRequired) {
      try {
        await assembleInvoiceBackup(gate.user.orgId, gate.user.id, result.id, result.backupType as BackupType, gate.allowedSubsidiaryIds)
      } catch (e) {
        console.error('billing backup auto-assemble failed', { requestId: id, invoiceId: result.id, error: e })
      }
    }
    return NextResponse.json({ documentId: result.id, documentNumber: result.documentNumber })
  } catch (e) {
    if (e instanceof BillingError && e.message === 'Billing request not found') return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (e instanceof BillingError && e.message === 'Inventory is disabled') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    if (e instanceof BillingError && e.message === 'Equipment is disabled') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    const status = e instanceof BillingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}

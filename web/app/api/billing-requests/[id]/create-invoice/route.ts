import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { generateInvoiceFromBillingRequest, BillingError } from '../../../../../lib/billing'
import { isRendererUnavailable } from '../../../../../lib/api/pdf-renderer'
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
    // never rendered inside it — and a failure is reported explicitly in
    // the response (never swallowed): the draft stands, the project tab
    // pins the failure to the request row, and issuing refuses until the
    // packet exists.
    let backup: { status: 'generated' | 'not_required' | 'failed'; error?: string } =
      result.backupRequired ? { status: 'generated' } : { status: 'not_required' }
    if (result.backupRequired) {
      try {
        await assembleInvoiceBackup(gate.user.orgId, gate.user.id, result.id, result.backupType as BackupType, gate.allowedSubsidiaryIds)
      } catch (e) {
        console.error('billing backup auto-assemble failed', { requestId: id, invoiceId: result.id, error: e })
        // A renderer outage is not a packet defect: the draft stands, but
        // the failure names the outage and its remedy instead of advising a
        // retry that would fail identically.
        backup = {
          status: 'failed',
          error: isRendererUnavailable(e) && e instanceof Error
            ? e.message
            : 'The backup packet could not be generated — generate it from the billing request, then submit the invoice',
        }
      }
    }
    return NextResponse.json({ documentId: result.id, documentNumber: result.documentNumber, backup })
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

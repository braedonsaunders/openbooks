import type { PrebillListRow, UnbilledProjectRow } from '../../../../lib/pre-billing'
import type { PrebillStage } from '../../../../lib/pre-billing-stages'

export function worksheet(stage: PrebillStage, overrides: Partial<PrebillListRow> = {}): PrebillListRow {
  return {
    id: `worksheet-${stage}`, worksheetNumber: `PB-${stage}`, projectId: 'project-1', projectName: 'Installation',
    customerName: 'Customer', periodStart: null, periodEnd: '2026-10-01', status: 'draft',
    originalBillAmount: '100.0000', proposedBillAmount: '100.0000', costAmount: '40.0000', adjustmentAmount: '0.0000',
    billingRequestId: null, invoiceDocumentId: null, invoiceNumber: null, createdAt: '2026-10-01T12:00:00Z',
    stage, projectTypeName: 'Time and materials', lineCount: 2, heldLineCount: 0, disputedLineCount: 0,
    customerReviewRequired: false, customerReviewSentAt: null, customerDecision: null, customerDecidedAt: null,
    customerSignerName: null, customerDecisionNote: null, customerPoNumber: null, customerViewedAt: null,
    invoiceStatus: null, invoiceTotal: null, invoiceOpenBalance: null, deliveredAt: null, ...overrides,
  }
}

export function unbilledProject(overrides: Partial<UnbilledProjectRow> = {}): UnbilledProjectRow {
  return {
    projectId: 'project-1', projectName: 'Installation', customerName: 'Customer', projectTypeName: 'Time and materials',
    unbilledAmount: '25.0000', sourceCount: 7, oldestWorkDate: '2026-09-01', ...overrides,
  }
}

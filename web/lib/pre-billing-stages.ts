import { decimalCmp } from './statement-format'

/**
 * The pre-billing board's stages, in the order work moves through them.
 *
 * A worksheet's lifecycle status covers preparation, approval and customer
 * review; once converted, the invoice it produced decides the rest — sent
 * once delivered, paid once its open balance is cleared. An invoice voided
 * after conversion returns its work to unbilled, so the worksheet leaves the
 * board as void.
 */
export const PREBILL_STAGES = ['draft', 'review', 'ready', 'customer', 'invoiced', 'sent', 'paid', 'void'] as const

export type PrebillStage = (typeof PREBILL_STAGES)[number]

export interface PrebillStageFacts {
  status: string
  invoiceStatus: string | null
  invoiceOpenBalance: string | null
  deliveredAt: string | null
}

export function prebillStage(facts: PrebillStageFacts): PrebillStage {
  switch (facts.status) {
    case 'draft': return 'draft'
    case 'review': return 'review'
    case 'approved': return 'ready'
    case 'customer_review': return 'customer'
    case 'converted': {
      if (facts.invoiceStatus === 'voided') return 'void'
      if (facts.invoiceStatus === 'posted' && facts.invoiceOpenBalance != null
          && decimalCmp(facts.invoiceOpenBalance, '0') <= 0) return 'paid'
      return facts.deliveredAt ? 'sent' : 'invoiced'
    }
    default: return 'void'
  }
}

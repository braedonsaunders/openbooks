import type { ReactNode } from 'react'
import {
  ClipboardList,
  ClipboardCheck,
  Scroll,
  BookOpen,
  Banknote,
  ArrowLeftRight,
  CreditCard,
  FileText,
  ReceiptText,
} from 'lucide-react'

/**
 * Beautiful, consistent transaction-type identity shown at the top of every
 * document flyout — so you always know whether you're looking at a Vendor Bill,
 * a Customer Invoice, a Journal Entry, etc. Colour-coded by money-flow family
 * (purchases amber · sales teal · money-movement blue · ledger slate · cards
 * rose), each with an icon.
 */
export interface DocTypeMeta {
  label: string
  icon: ReactNode
  /** tailwind classes for the pill (bg/text/ring), light + dark. */
  cls: string
}

const ICON = 'h-3.5 w-3.5'

const AMBER = 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20'
const TEAL = 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-400/20'
const BLUE = 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-400/20'
const SLATE = 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20'
const VIOLET = 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-400/20'
const ROSE = 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20'

export const DOC_TYPE_META: Record<string, DocTypeMeta> = {
  vendor_bill: { label: 'Vendor Bill', icon: <ClipboardList className={ICON} />, cls: AMBER },
  vendor_credit: { label: 'Vendor Credit', icon: <ClipboardList className={ICON} />, cls: AMBER },
  purchase_order: { label: 'Purchase Order', icon: <ClipboardList className={ICON} />, cls: AMBER },
  customer_invoice: { label: 'Customer Invoice', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  customer_credit: { label: 'Customer Credit', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  sales_order: { label: 'Sales Order', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  quote: { label: 'Estimate', icon: <FileText className={ICON} />, cls: TEAL },
  expense_report: { label: 'Expense Report', icon: <ReceiptText className={ICON} />, cls: VIOLET },
  journal: { label: 'Journal Entry', icon: <BookOpen className={ICON} />, cls: SLATE },
  vendor_payment: { label: 'Vendor Payment', icon: <Banknote className={ICON} />, cls: BLUE },
  customer_payment: { label: 'Customer Payment', icon: <Banknote className={ICON} />, cls: BLUE },
  check: { label: 'Check', icon: <Banknote className={ICON} />, cls: BLUE },
  transfer: { label: 'Transfer', icon: <ArrowLeftRight className={ICON} />, cls: SLATE },
  card_charge: { label: 'Card Charge', icon: <CreditCard className={ICON} />, cls: ROSE },
  card_refund: { label: 'Card Refund', icon: <CreditCard className={ICON} />, cls: ROSE },
}

const humanize = (kind: string) => kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** The transaction-type pill for a document flyout header. */
export function DocTypeBadge({ kind }: { kind: string }) {
  const meta = DOC_TYPE_META[kind] ?? { label: humanize(kind), icon: <FileText className={ICON} />, cls: SLATE }
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide uppercase ring-1 ring-inset ' +
        meta.cls
      }
    >
      {meta.icon}
      {meta.label}
    </span>
  )
}

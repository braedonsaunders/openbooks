'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import type { ReportCellLink } from '@openbooks/reports'
import { transactionDrawerHref } from '../../../lib/txn-links'
import { OverlayLink } from '../../../components/overlay-link'
import { useReportOverlayOptional } from '../../../components/navigation-provider'

type TransactionCellLink = Extract<ReportCellLink, { kind: 'transaction' }>

type TxnLinkProps = {
  className?: string
  children: React.ReactNode
} & (
  | { target: TransactionCellLink; entryId?: never; docKind?: never; docId?: never }
  | { target?: never; entryId: string; docKind?: string | null; docId?: string | null }
)

/**
 * Opens a transaction in its REAL native flyout — never a read-only overlay,
 * and never by navigating away from the page you're on:
 *
 * - Source-document transactions (bill, invoice, payment, manual journal, …)
 *   stay on the CURRENT page and open the record's native drawer over it via
 *   the shell-level GlobalReportDrawerHost (?reportRecord= / ?reportRecordKind=
 *   with the org's custom form applied). This works everywhere — reports,
 *   analytics drills, the cash/AP/AR cockpit flyouts.
 * - System-generated GL entries with no document (depreciation, closing, fx)
 *   open the read-only EntryFlyout in place.
 */
export function TxnLink(props: TxnLinkProps) {
  const { className, children } = props
  const entryId = props.target ? props.target.entryId : props.entryId
  const docKind = props.target ? props.target.docKind : props.docKind
  const docId = props.target ? props.target.docId : props.docId
  const nextPath = usePathname() ?? '/'
  const nextSearch = useSearchParams()
  const overlay = useReportOverlayOptional()
  const href = transactionDrawerHref({
    pathname: overlay?.pathname ?? nextPath,
    query: overlay?.search ?? nextSearch.toString(),
    entryId,
    docKind,
    docId,
  })
  return (
    <OverlayLink href={href} className={className}>
      {children}
    </OverlayLink>
  )
}

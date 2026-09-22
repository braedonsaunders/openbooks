'use client'

import type { ComponentProps } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { encodeReportDrillTarget, type ReportDrillTarget } from '../../../lib/report-drill'
import { hrefWithOverlay } from '../../../lib/report-overlay'
import { OverlayLink } from '../../../components/overlay-link'
import { useReportOverlayOptional } from '../../../components/navigation-provider'

export function ReportDrillLink({
  target,
  ...props
}: Omit<ComponentProps<typeof OverlayLink>, 'href' | 'target'> & { target: ReportDrillTarget }) {
  const nextPath = usePathname() ?? '/reports'
  const nextSearch = useSearchParams()
  const overlay = useReportOverlayOptional()
  const pathname = overlay?.pathname ?? nextPath
  const href = hrefWithOverlay(pathname, overlay?.search ?? nextSearch.toString(), {
    reportDrill: encodeReportDrillTarget(target),
    reportDrillPage: null,
    txn: null,
    reportRecord: null,
    reportRecordKind: null,
    drawerReturn: null,
  })
  return <OverlayLink {...props} href={href} />
}

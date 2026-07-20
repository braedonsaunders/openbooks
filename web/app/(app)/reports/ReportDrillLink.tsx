'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type { ComponentProps } from 'react'
import { encodeReportDrillTarget, type ReportDrillTarget } from '../../../lib/report-drill'

export function ReportDrillLink({
  drillTarget,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href'> & { drillTarget: ReportDrillTarget }) {
  const pathname = usePathname() ?? '/reports'
  const current = useSearchParams()
  const params = new URLSearchParams(current.toString())
  params.set('reportDrill', encodeReportDrillTarget(drillTarget))
  params.delete('reportDrillPage')
  params.delete('txn')
  params.delete('reportRecord')
  params.delete('reportRecordKind')
  params.delete('drawerReturn')
  return <Link {...props} href={`${pathname}?${params.toString()}`} scroll={false} />
}

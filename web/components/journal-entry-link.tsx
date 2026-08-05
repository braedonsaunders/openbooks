'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

/** Opens posted GL impact as a stacked drawer without leaving its source record. */
export function JournalEntryLink({
  entryId,
  className,
  children,
}: {
  entryId: string
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? '/'
  const current = useSearchParams()
  const params = new URLSearchParams(current.toString())
  params.set('txn', entryId)
  return (
    <Link href={`${pathname}?${params}` as never} className={className} scroll={false}>
      {children}
    </Link>
  )
}

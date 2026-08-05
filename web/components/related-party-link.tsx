'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

export type RelatedPartyRole = 'customer' | 'vendor' | 'employee'

export function relatedPartyHref(
  pathname: string,
  query: string,
  partyId: string,
  role?: RelatedPartyRole,
) {
  const params = new URLSearchParams(query)
  params.set('relatedParty', partyId)
  if (role) params.set('relatedPartyRole', role)
  else params.delete('relatedPartyRole')
  const nextQuery = params.toString()
  return nextQuery ? `${pathname}?${nextQuery}` : pathname
}

/** Opens a party over the current page instead of navigating away from it. */
export function RelatedPartyLink({
  partyId,
  role,
  className,
  children,
}: {
  partyId: string
  role?: RelatedPartyRole
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()
  return (
    <Link
      href={relatedPartyHref(pathname, searchParams.toString(), partyId, role) as never}
      scroll={false}
      className={className}
    >
      {children}
    </Link>
  )
}

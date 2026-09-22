'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { accountRegisterHref } from '../lib/account-register-navigation'
import { OverlayLink } from './overlay-link'
import { useReportOverlayOptional } from './navigation-provider'

/**
 * Opens an account register over the current workspace. Keeping the current
 * pathname and query intact means closing the register restores the exact
 * report/list filters and drawer context the user started from.
 */
export function AccountRegisterLink({
  accountId,
  from,
  to,
  className,
  ariaLabel,
  title,
  children,
}: {
  accountId: string
  from?: string
  to?: string
  className?: string
  ariaLabel?: string
  title?: string
  children: React.ReactNode
}) {
  const nextPath = usePathname() ?? '/accounts'
  const nextSearch = useSearchParams()
  const overlay = useReportOverlayOptional()
  const href = accountRegisterHref(
    overlay?.pathname ?? nextPath,
    overlay?.search ?? nextSearch.toString(),
    accountId,
    { from, to },
  )

  return (
    <OverlayLink href={href} className={className} aria-label={ariaLabel} title={title}>
      {children}
    </OverlayLink>
  )
}

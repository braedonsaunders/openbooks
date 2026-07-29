'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { accountRegisterHref } from '../lib/account-register-navigation'

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
  children,
}: {
  accountId: string
  from?: string
  to?: string
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? '/accounts'
  const current = useSearchParams()
  const href = accountRegisterHref(pathname, current.toString(), accountId, { from, to })

  return (
    <Link href={href as never} className={className} scroll={false}>
      {children}
    </Link>
  )
}

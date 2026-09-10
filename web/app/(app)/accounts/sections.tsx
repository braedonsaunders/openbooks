import Link from 'next/link'
import { BookOpenText } from 'lucide-react'
import { Badge, cn } from '@openbooks/ui'
import { AccountRegisterLink } from '../../../components/account-register-link'

/**
 * The account cell of the flat search results: number gutter, name link, an
 * optional inactive chip and an optional parent path. Three conditionals in
 * one cell, so it is a component — `when` omits a block, it does not choose
 * between two.
 */
export function AccountNameCell({
  number,
  name,
  href,
  isSummary,
  inactiveLabel,
  parentPath,
}: {
  number: string
  name: string
  href: string
  isSummary: boolean
  inactiveLabel: string | null
  parentPath: string | null
}) {
  return (
    <div className="flex min-w-0 items-start">
      <span className="mr-3 w-20 shrink-0 pt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
        {number}
      </span>
      <div className="min-w-0">
        <Link
          href={href as never}
          className={cn('hover:text-teal-700 hover:underline dark:hover:text-teal-300', isSummary && 'font-semibold')}
        >
          {name}
        </Link>
        {inactiveLabel ? <Badge variant="outline" className="ml-2">{inactiveLabel}</Badge> : null}
        {parentPath ? <p className="mt-0.5 truncate text-xs text-slate-400 dark:text-slate-500">{parentPath}</p> : null}
      </div>
    </div>
  )
}

/** The register shortcut at the end of an account row. */
export function AccountRegisterCell({
  accountId,
  ariaLabel,
  title,
}: {
  accountId: string
  ariaLabel: string
  title: string
}) {
  return (
    <AccountRegisterLink
      accountId={accountId}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-teal-700 dark:hover:bg-slate-800 dark:hover:text-teal-300"
      ariaLabel={ariaLabel}
      title={title}
    >
      <BookOpenText size={15} />
    </AccountRegisterLink>
  )
}

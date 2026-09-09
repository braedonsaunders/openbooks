import { DocTypeBadge } from '../../../../components/doc-type-badge'
import { AccountRegisterLink } from '../../../../components/account-register-link'
import { TxnLink } from '../TxnLink'

/**
 * The two small composites the general ledger puts inside its markup.
 *
 * Both are components rather than blocks for the reason established on the
 * purchasing cockpit: they are a few lines of one-off composition, and a block
 * per such composite would grow the vocabulary without converging. Both render
 * paths import these, so they cannot drift.
 */

/** The per-account heading above each ledger table. */
export function AccountHeading({
  accountId,
  from,
  to,
  number,
  name,
}: {
  accountId: string
  from: string
  to: string
  number: string | null
  name: string
}) {
  return (
    <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold">
      <AccountRegisterLink
        accountId={accountId}
        from={from}
        to={to}
        className="hover:text-teal-700 dark:hover:text-teal-300"
      >
        <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{number}</span>
        {name}
      </AccountRegisterLink>
    </h3>
  )
}

/** The entry cell: transaction link beside its document-type badge. */
export function EntryCell({
  entryId,
  docKind,
  docId,
  entryNumber,
}: {
  entryId: string
  docKind: string | null
  docId: string | null
  entryNumber: string | null
}) {
  return (
    <span className="flex items-center gap-1.5">
      <TxnLink
        entryId={entryId}
        docKind={docKind}
        docId={docId}
        className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300"
      >
        {entryNumber}
      </TxnLink>
      {docKind && <DocTypeBadge kind={docKind} icon={false} />}
    </span>
  )
}

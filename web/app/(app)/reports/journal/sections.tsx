import { DocTypeBadge } from '../../../../components/doc-type-badge'
import { TxnLink } from '../TxnLink'

/**
 * The heading line above each journal entry's line table.
 *
 * Extracted for the same reason as the purchasing rail sections: it is a
 * handful of one-off inline markup, and a block per such heading would grow
 * the vocabulary without converging. Both render paths import this, so they
 * cannot drift.
 *
 * The origin label arrives already translated — `t.has()` fallback logic is
 * loader work, not presentation.
 */
export function JournalEntryHeading({
  entryId,
  docKind,
  docId,
  entryNumber,
  date,
  originLabel,
  memo,
}: {
  entryId: string
  docKind: string | null
  docId: string | null
  entryNumber: string | null
  date: string
  originLabel: string
  memo: string | null
}) {
  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="flex items-center gap-1.5">
        <TxnLink
          entryId={entryId}
          docKind={docKind}
          docId={docId}
          className="font-mono font-semibold hover:text-teal-700 dark:hover:text-teal-300"
        >
          {entryNumber}
        </TxnLink>
        {docKind && <DocTypeBadge kind={docKind} icon={false} />}
      </span>
      <span className="tabular-nums text-slate-500 dark:text-slate-400">{date}</span>
      <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {originLabel}
      </span>
      {memo && <span className="text-slate-500 dark:text-slate-400">{memo}</span>}
    </div>
  )
}

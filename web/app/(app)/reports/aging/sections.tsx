import Link from 'next/link'

/**
 * A party cell that links to the party's statement, or renders the "no party"
 * placeholder when the row has none.
 *
 * Two conditional forms in one cell, which is the established boundary for a
 * component rather than a block. Shared by the page and the widget registry and by both the
 * summary and detail tables.
 */
export function PartyLinkCell({
  partyId,
  partyName,
  href,
  note,
}: {
  partyId: string | null
  partyName: string
  href: string
  /** Provenance for partyless rows: control lines with no counterparty read
   * as operating items missing one, so the cell says what they are. */
  note?: string | null
}) {
  if (!partyId) {
    return (
      <span>
        <span className="text-slate-400 italic">{partyName}</span>
        {note ? <span className="block text-xs font-normal not-italic text-slate-400 dark:text-slate-500">{note}</span> : null}
      </span>
    )
  }
  return (
    <Link href={href as never} className="hover:text-teal-700 dark:hover:text-teal-300">
      {partyName}
    </Link>
  )
}

import Link from 'next/link'

/**
 * A party cell that links to the party's statement, or renders the "no party"
 * placeholder when the row has none.
 *
 * Two conditional forms in one cell, which is the established boundary for a
 * component rather than a block. Shared by both render paths and by both the
 * summary and detail tables.
 */
export function PartyLinkCell({
  partyId,
  partyName,
  href,
}: {
  partyId: string | null
  partyName: string
  href: string
}) {
  if (!partyId) return <span className="text-slate-400 italic">{partyName}</span>
  return (
    <Link href={href as never} className="hover:text-teal-700 dark:hover:text-teal-300">
      {partyName}
    </Link>
  )
}

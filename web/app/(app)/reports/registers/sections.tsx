import Link from 'next/link'
import { ReportDrillLink } from '../ReportDrillLink'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * The per-party heading above each register table: the party's name (linked to
 * its statement when it has an id) plus its drilled closing balance.
 *
 * A component rather than a block because it mixes two conditional link forms
 * with inline typography — a few lines of one-off composition, which is the
 * established boundary. Both render paths import it.
 */
export function PartyHeading({
  partyId,
  partyName,
  statementHref,
  closingLabel,
  closing,
  closingDrill,
}: {
  partyId: string | null
  partyName: string
  statementHref: string
  closingLabel: string
  closing: string
  closingDrill: ReportDrillTarget
}) {
  return (
    <h3 className="mb-1 flex items-baseline gap-3 text-sm font-semibold">
      {partyId ? (
        <Link href={statementHref as never} className="hover:text-teal-700 dark:hover:text-teal-300">
          {partyName}
        </Link>
      ) : (
        <span className="text-slate-400 italic">{partyName}</span>
      )}
      <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
        {closingLabel}:{' '}
        <ReportDrillLink
          target={closingDrill}
          className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
        >
          {closing}
        </ReportDrillLink>
      </span>
    </h3>
  )
}

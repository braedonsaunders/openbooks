import Link from 'next/link'

/**
 * One pack's open-findings cell for the Agents overview table: a link into
 * findings only when the count is above zero, otherwise the loader-resolved
 * line as muted plain text like other zero-count columns.
 */
export function AgentsPackFindings({
  openFindings,
  findingsLine,
  reviewHref,
}: {
  openFindings: number
  findingsLine: string
  reviewHref: string
}) {
  if (openFindings > 0) {
    return (
      <Link href={reviewHref} className="font-medium text-teal-700 underline dark:text-teal-300">
        {findingsLine}
      </Link>
    )
  }
  return <span className="text-sm text-slate-500 dark:text-slate-400">{findingsLine}</span>
}

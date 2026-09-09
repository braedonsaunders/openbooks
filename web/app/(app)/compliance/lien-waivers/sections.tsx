import Link from 'next/link'

/**
 * Waiver number as a link, followed by its direction in muted small text.
 *
 * A link with a trailing annotation: `text` can carry a suffix and `link`
 * cannot, and rather than widen either renderer for one page this stays a
 * component. Shared by both render paths.
 */
export function WaiverNumberCell({
  waiverNumber,
  href,
  directionLabel,
}: {
  waiverNumber: string
  href: string
  directionLabel: string
}) {
  return (
    <>
      <Link href={href as never} className="hover:underline">
        {waiverNumber}
      </Link>
      <span className="ml-2 text-xs text-slate-400">{directionLabel}</span>
    </>
  )
}

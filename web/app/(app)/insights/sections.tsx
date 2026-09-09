import Link from 'next/link'
import { VIZ_META } from './viz-meta'

/**
 * The two composite cells in the insight-cards list.
 *
 * The chart cell is the interesting one: it renders a per-visualization ICON
 * component looked up from VIZ_META. A component reference is exactly what a
 * spec must never carry, so the loader passes the viz type and the lookup
 * happens here.
 */

/** Card name over its optional description. */
export function CardNameCell({
  name,
  href,
  description,
}: {
  name: string
  href: string
  description: string | null
}) {
  return (
    <>
      <Link href={href as never} className="text-teal-700 hover:underline dark:text-teal-300">
        {name}
      </Link>
      {description ? (
        <div className="text-xs font-normal text-slate-500 dark:text-slate-400">{description}</div>
      ) : null}
    </>
  )
}

/** Visualization icon beside its localized label. */
export function VizCell({ vizType, label }: { vizType: string; label: string }) {
  const viz = VIZ_META.find((v) => v.value === vizType)
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
      {viz ? <viz.Icon size={15} /> : null}
      {label}
    </span>
  )
}

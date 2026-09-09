import Link from 'next/link'

/**
 * The two composite cells in the saved-views list.
 *
 * Both are a handful of one-off composition with conditional parts, which is
 * the established boundary for a component rather than a block. Shared by both
 * render paths.
 */

/** View name (which RUNS the view) over its optional description. */
export function ViewNameCell({
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
      {/* Name RUNS the view (source platform behaviour); editing is the
          explicit action on the right. */}
      <Link href={href as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
        {name}
      </Link>
      {description ? (
        <div className="text-xs text-slate-500 dark:text-slate-400">{description}</div>
      ) : null}
    </>
  )
}

/** Run, plus Edit when the viewer owns the view or is an admin. */
export function ViewActionsCell({
  runHref,
  runLabel,
  editHref,
  editLabel,
  canEdit,
}: {
  runHref: string
  runLabel: string
  editHref: string
  editLabel: string
  canEdit: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Link href={runHref as never} className="text-teal-700 hover:underline dark:text-teal-300">
        {runLabel}
      </Link>
      {canEdit ? (
        <Link
          href={editHref as never}
          className="text-slate-500 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
        >
          {editLabel}
        </Link>
      ) : null}
    </div>
  )
}

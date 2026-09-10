import Link from 'next/link'

/**
 * The draft-manual-journals panel above the posted-entries list.
 *
 * A conditional composite (heading + one row per draft, each row a link over
 * four spans), so it is a component — `when` omits a block, it does not
 * choose between two. Both render paths share this one implementation: the
 * native page imports it back, and the spec places it as `journal-drafts`.
 *
 * Rows arrive presentation-ready from the loader (`href`, formatted `total`);
 * the component binds fields and renders no logic of its own.
 */
export interface JournalDraftRow {
  id: string
  href: string
  documentNumber: string
  documentDate: string
  memo: string | null
  total: string
}

export function JournalDraftsPanel({
  heading,
  drafts,
}: {
  heading: string
  drafts: JournalDraftRow[]
}) {
  return (
    <div className="mb-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {heading}
      </p>
      <div className="flex flex-col gap-0.5">
        {drafts.map((d) => (
          <Link
            key={d.id}
            href={(d.href)}
            className="flex items-center gap-3 rounded px-1.5 py-1 text-sm hover:bg-white dark:hover:bg-slate-800/60"
          >
            <span className="font-mono text-[13px] font-semibold text-teal-700 dark:text-teal-300">
              {d.documentNumber}
            </span>
            <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">{d.documentDate}</span>
            <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{d.memo}</span>
            <span className="tabular-nums">{d.total}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

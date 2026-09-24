import Link from 'next/link'
import { ChevronRight, Home, Trash2 } from 'lucide-react'

/**
 * Pieces of the documents page that the page and the widget registry share.
 *
 * They live here rather than inside `page.tsx` for the reason SortTh taught:
 * two implementations of the same visual element drift, and a conformance
 * harness that compares one against the other would then be measuring the
 * drift instead of the conversion. One implementation, two callers.
 *
 * Everything below is a 1:1 move of the native page's markup — the header
 * actions cluster, the sticky breadcrumb strip, the full-height shell and the
 * tree/list/drawer slots. Interactivity stays where it already lives: the
 * sidebar tree, the file table (checkboxes, context menu, bulk bar), and the
 * drawers are client components owned by the coordinator's registry entries.
 * This file only holds the two composites whose markup the spec cannot
 * re-express; the shell itself is plain grids in the spec.
 */

/** Crumb label type shared by the page loader and this strip. */
export interface DocumentCrumb {
  id: string
  name: string
  href: string
  isLast: boolean
}

/** The breadcrumb path pinned above the listing. */
export function DocumentsBreadcrumb({
  homeHref,
  homeLabel,
  crumbs,
}: {
  homeHref: string
  homeLabel: string
  crumbs: DocumentCrumb[]
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-slate-200 bg-white/95 px-3 py-2 text-sm backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-slate-900/95">
      <Link
        href={homeHref as never}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      >
        <Home className="h-3.5 w-3.5" />
        {homeLabel}
      </Link>
      {crumbs.map((c) => (
        <span key={c.id} className="flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600" />
          {c.isLast ? (
            <span className="px-1.5 py-0.5 font-medium text-slate-800 dark:text-slate-100">
              {c.name}
            </span>
          ) : (
            <Link
              href={c.href as never}
              className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              {c.name}
            </Link>
          )}
        </span>
      ))}
    </div>
  )
}

/**
 * The stale deep-link notice: ?file= / ?folder= named something the loader
 * could not resolve (malformed id, deleted item, or nothing shared). The
 * drawers stay closed by design — opening one would report success for work
 * with no record — so the page says so instead of rendering the plain list
 * as if the link had worked.
 */
export function DocumentsLinkNotice({ message }: { message: string }) {
  return (
    <div
      className="mx-3 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 sm:mx-4 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
      role="alert"
    >
      {message}
    </div>
  )
}

/**
 * The header actions cluster (trash link, new-folder, upload). A conditional
 * trio in one wrapper is a composite, not a list of cells, so it stays a
 * component: a spec can place it, but cannot decide which buttons appear.
 */
export function DocumentsActions({
  trashHref,
  trashLabel,
  newFolder,
  upload,
}: {
  trashHref: string
  trashLabel: string
  newFolder: React.ReactNode
  upload: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={trashHref as never}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <Trash2 className="h-4 w-4" />
        {trashLabel}
      </Link>
      {newFolder}
      {upload}
    </div>
  )
}

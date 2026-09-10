import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

/**
 * Back link above the trash header, moved here from page.tsx so the native
 * render and the `trash-back-link` widget share one implementation.
 *
 * This stays a local component rather than `pageHeader({ back })` because the
 * native markup — a `next/link` with a chevron icon and its own class string —
 * is not what PageHeader's `back` slot renders (UiBackLink: `← label` with
 * different classes). Transcribed verbatim from the native page.
 */
export function TrashBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
    >
      <ChevronLeft className="h-3.5 w-3.5" />
      {label}
    </Link>
  )
}

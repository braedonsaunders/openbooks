import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

/**
 * The customise page's heading stack, moved out of `page.tsx` so both render
 * paths share one implementation.
 *
 * A component rather than `pageHeader({ back })`: that block's back slot
 * renders `UiBackLink` (an `←` glyph and its own classes), and this page uses
 * a lucide `ArrowLeft` at 12px inside a link with different classes again. The
 * two look similar and are not the same markup — which is exactly the kind of
 * difference the conformance harness exists to refuse.
 */
export function CustomizeDashboardHeader({
  backHref,
  backLabel,
  title,
  roleLabel,
}: {
  backHref: string
  backLabel: string
  title: string
  roleLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
        >
          <ArrowLeft size={12} />
          {backLabel}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{roleLabel}</p>
      </div>
    </div>
  )
}

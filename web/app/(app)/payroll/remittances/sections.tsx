import Link from 'next/link'
import { RemittancesView } from './RemittancesView'

/**
 * The remittance cockpit's shared sections.
 *
 * The page body is one client cockpit — the period form, the per-destination
 * cards (each with its conditional filing-account badge, existing-bill
 * links, and create-bill vs assign-vendor action), and the empty state. It
 * stays whole: every card carries conditional pairs a spec cannot express,
 * so the spec places the cockpit through a widget and the page and the widget registry
 * share this one implementation. Display strings resolve inside the client
 * component via useTranslations/useMoney, identically wherever it renders.
 */

export { RemittancesView }

/** The AP footnote under the cards. A link over static copy is a composite cell, so it lives here. */
export function RemittanceApNote({ note, linkLabel }: { note: string; linkLabel: string }) {
  return (
    <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
      {note} <Link className="underline" href={'/ap/bills' as never}>{linkLabel}</Link>
    </p>
  )
}

import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * The banking cockpit's bespoke rail sections, extracted from the page.
 *
 * Each of these is a handful of one-off markup, and inventing a ViewSpec
 * block for each would grow the vocabulary one page at a time without ever
 * converging. Extracting them instead means the native page and the spec
 * render the SAME component rather than two hand-kept copies, so they cannot
 * drift — the same division the purchasing cockpit established (see
 * ../../purchasing/sections.tsx): ViewSpec composes the grid and the panels;
 * the panel BODIES stay components.
 *
 * The roster hero stays OUT of this file on purpose: it is a live, stateful
 * workspace (user hide/reorder prefs persisted through /api/me/page-layout)
 * rendered by the shared AccountsRosterPanel through the `banking-roster`
 *  widget. The loader fetches the prefs
 * and passes them as data; persistence rides the session cookie, so the
 * widget carries no user id, org id or Authz.
 */

export type BankingAttentionItem = {
  tone: 'negative' | 'warning' | 'neutral'
  text: string
  href: string
}

/**
 * The needs-attention queue, INCLUDING its empty state.
 *
 * The empty case lives here rather than as a conditional pair of blocks in
 * the spec on purpose. Expressing "render A when the list is empty,
 * otherwise B" would require the spec language to gain a negated
 * conditional, and once it has one of those the argument against arithmetic
 * and comparisons gets much weaker. A component that knows how to render
 * itself when it has no rows is the ordinary answer.
 */
export function BankingAttentionList({
  items,
  allClear,
}: {
  items: BankingAttentionItem[]
  allClear: string
}) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{allClear}</p>
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {items.map((item, i) => (
        <li key={i}>
          <Link
            href={item.href as never}
            className="flex items-start gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <span
              className={cn(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                item.tone === 'negative' ? 'bg-red-500' : item.tone === 'warning' ? 'bg-amber-500' : 'bg-teal-500',
              )}
            />
            <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">{item.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

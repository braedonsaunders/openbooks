import Link from 'next/link'
import { Badge } from '@openbooks/ui'

/**
 * Two cells whose content depends on the record type's publication state.
 *
 * Both are "link when published, plain otherwise", which is a conditional
 * PAIR rather than a presence flag — the spec has no way to express it, and
 * giving it one would mean adding a negation. Components instead.
 */

/** Record count, linked to the records list once the type is published. */
export function RecordCountCell({ count, href, linked }: { count: string; href: string; linked: boolean }) {
  if (!linked) return <>{count}</>
  return (
    <Link href={href as never} className="text-teal-700 hover:underline dark:text-teal-300">
      {count}
    </Link>
  )
}

/** "Shown in nav" badge, or an em-dash when it is not. */
export function InNavCell({ shown, label }: { shown: boolean; label: string }) {
  if (!shown) return <span className="text-slate-400 dark:text-slate-500">—</span>
  return <Badge variant="default">{label}</Badge>
}

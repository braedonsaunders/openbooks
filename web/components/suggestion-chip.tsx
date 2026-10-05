import Link from 'next/link'
import { Badge } from '@openbooks/ui'

/**
 * The one-click path into a proposed fix. The chip itself resolves nothing:
 * every parked order and every unmatched settlement line already carries at
 * least a manual proposal, so the badge is truthful on each row it renders
 * on — and the row drawer loads the real suggestion with its evidence and
 * the approve action. Rendered through the entity list's trailing slot,
 * never as a forked list.
 */
export function SuggestionChip({ href, label, title }: { href: string; label: string; title?: string }) {
  return (
    <Link
      href={href}
      title={title ?? label}
      aria-label={title ?? label}
      className="inline-flex items-center rounded-full transition-colors hover:opacity-80"
    >
      <Badge variant="outline">{label}</Badge>
    </Link>
  )
}

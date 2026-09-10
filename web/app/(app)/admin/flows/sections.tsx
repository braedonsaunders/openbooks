import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import { NewFlowButton, FlowRowActions } from './FlowsClient'

/**
 * The flows list's composite cells, extracted from page.tsx.
 *
 * Three cells are more than one element each, so the spec cannot express them
 * as leaf cells: the name link (class-carrying anchor), the last-run pair
 * (badge + timestamp, or the never-ran fallback), and the row actions (the
 * client enable/delete controls WITH their revision key). Each is a verbatim
 * move of the native markup; page.tsx imports them back so both render paths
 * share one implementation. Never write a second copy.
 */

/** `<Link className="font-medium text-teal-700 hover:underline …">` — the
 *  spec's link cell carries no className contract for this treatment. */
export function FlowNameCell({ name, href }: { name: string; href: string }) {
  return (
    <Link
      href={href}
      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
    >
      {name}
    </Link>
  )
}

/** Badge + timestamp when the flow has run, else the never-ran label. The
 *  loader resolves which case applies to nullable `status`/`at` fields; the
 *  component chooses between the two layouts — a conditional PAIR, which is
 *  a component, not a spec construct. */
export function FlowLastRunCell({
  status,
  variant,
  at,
  fallback,
}: {
  status: string | null
  variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
  at: string | null
  fallback: string
}) {
  if (at === null) return <>{fallback}</>
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={variant}>{status}</Badge>
      <span className="tabular-nums">{at}</span>
    </span>
  )
}

/** The client enable/delete controls. The `key={updatedAt}` remount (the
 *  revision the toggle/delete calls send as `expectedUpdatedAt`) rides on
 *  the component itself, exactly as the native page keys it — a key the
 *  loader cannot ship through widget props. */
export function FlowRowActionsCell({
  id,
  name,
  enabled,
  updatedAt,
}: {
  id: string
  name: string
  enabled: boolean
  updatedAt: string
}) {
  return (
    <FlowRowActions
      id={id}
      name={name}
      enabled={enabled}
      updatedAt={updatedAt}
      key={updatedAt}
    />
  )
}

export { NewFlowButton }

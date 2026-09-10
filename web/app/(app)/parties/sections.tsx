import { Badge } from '@openbooks/ui'

/**
 * The role chips on a party row. Three optional badges in one wrapper is a
 * conditional composite, not a list of cells, so it stays a component: a spec
 * can place it, but cannot decide which chips appear.
 */
export function PartyRolesCell({
  badges,
}: {
  badges: { label: string; variant: 'default' | 'secondary' | 'outline' }[]
}) {
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.variant} variant={b.variant}>
          {b.label}
        </Badge>
      ))}
    </span>
  )
}

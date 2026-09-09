import { Building2, ExternalLink } from 'lucide-react'
import { Badge, Button } from '@openbooks/ui'
import { enterOrganizationAction } from '../actions'

/**
 * The composite cells in the organizations list.
 *
 * The workspace cell posts a SERVER ACTION with the org id. A form action is
 * authority, not presentation, so the spec passes the id and the binding lives
 * here — the same rule as the revoke control on cross-org access.
 */

export function OrgNameCell({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <>
      <div className="font-medium text-slate-900 dark:text-slate-100">{name}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</div>
    </>
  )
}

export function OrgEnvironmentCell({
  envKind,
  variant,
  parentNote,
}: {
  envKind: string
  variant: 'success' | 'warning' | 'secondary'
  parentNote: string
}) {
  return (
    <>
      <Badge variant={variant}>{envKind}</Badge>
      {parentNote ? (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{parentNote}</div>
      ) : null}
    </>
  )
}

export function OrgLocaleCell({ country, currency }: { country: string; currency: string }) {
  return (
    <>
      <div>{country}</div>
      <div className="text-xs text-slate-500">{currency}</div>
    </>
  )
}

export function OrgUsersCell({ active, total }: { active: string; total: string }) {
  return (
    <>
      <span className="font-medium tabular-nums">{active}</span>
      <span className="text-slate-400"> / {total}</span>
    </>
  )
}

export function OrgOpenCell({ orgId }: { orgId: string }) {
  return (
    <form action={enterOrganizationAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <Button type="submit" size="sm" variant="outline">
        Open <ExternalLink size={14} />
      </Button>
    </form>
  )
}

export const ORG_EMPTY_ICON = <Building2 />

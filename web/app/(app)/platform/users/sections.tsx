import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Badge, Button } from '@openbooks/ui'

/**
 * Composite cells in the platform users list.
 *
 * The identity cell carries two independent status badges and the roles cell
 * renders a variable-length badge list — neither is a value, so both are
 * components rather than block vocabulary.
 */

export function UserIdentityCell({
  name,
  href,
  email,
  isSuperAdmin,
  isActive,
}: {
  name: string
  href: string
  email: string
  isSuperAdmin: boolean
  isActive: boolean
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Link
          href={href as never}
          className="font-medium text-slate-900 hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
        >
          {name}
        </Link>
        {isSuperAdmin ? (
          <Badge variant="warning" className="gap-1">
            <ShieldAlert size={11} /> super admin
          </Badge>
        ) : null}
        {!isActive ? <Badge variant="secondary">inactive</Badge> : null}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{email}</div>
    </>
  )
}

export function UserRolesCell({ roles }: { roles: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((role) => (
        <Badge key={role} variant="outline">
          {role}
        </Badge>
      ))}
    </div>
  )
}

/** Explicit grant count, or a note that the user only sees their home org. */
export function UserGrantsCell({ label, emphasised }: { label: string; emphasised: boolean }) {
  if (!emphasised) return <span className="text-slate-500">{label}</span>
  return <span className="font-medium tabular-nums">{label}</span>
}

export function UserManageCell({ href }: { href: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={href as never}>Manage</Link>
    </Button>
  )
}

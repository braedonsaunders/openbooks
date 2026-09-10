import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailHeader,
} from '@openbooks/ui'
import { revokeAccessAction, setSuperAdminAction } from '../../actions'
import { PlatformMutationButton } from '../../_components/PlatformMutationButton'

/**
 * Pieces of the platform user record that both render paths share.
 *
 * Every one of them exists because a SERVER ACTION is involved. A bound action
 * is a capability, not data — it can never travel through a spec — so the
 * widget takes the ids and binds the action itself, exactly as the native page
 * does. The spec says which user; the host decides what may be done to them.
 */

export function PlatformUserHeader({
  userId,
  name,
  subtitle,
  isActive,
  isSuperAdmin,
  isSelf,
  backHref,
  backLabel,
}: {
  userId: string
  name: string
  subtitle: string
  isActive: boolean
  isSuperAdmin: boolean
  isSelf: boolean
  backHref: string
  backLabel: string
}) {
  return (
    <DetailHeader
      back={{ href: backHref, label: backLabel }}
      title={name}
      subtitle={subtitle}
      badge={
        <div className="flex items-center gap-2">
          <Badge variant={isActive ? 'success' : 'secondary'}>
            {isActive ? 'active' : 'inactive'}
          </Badge>
          {isSuperAdmin ? <Badge variant="warning">super admin</Badge> : null}
        </div>
      }
      actions={
        <PlatformMutationButton
          action={setSuperAdminAction.bind(null, userId, !isSuperAdmin)}
          success={isSuperAdmin ? 'Super-admin access revoked' : 'Super-admin access granted'}
          variant={isSuperAdmin ? 'destructive' : 'outline'}
          disabled={isSelf && isSuperAdmin}
        >
          {isSuperAdmin ? (isSelf ? 'Current operator' : 'Revoke super admin') : 'Make super admin'}
        </PlatformMutationButton>
      }
    />
  )
}

/** A grant's acting identity: display name over its email. */
export function GrantActingCell({ name, email }: { name: string; email: string }) {
  return (
    <>
      <div>{name}</div>
      <div className="text-xs text-slate-500">{email}</div>
    </>
  )
}

/** Revoke control, or the preserved marker once a grant is already revoked. */
export function GrantControlCell({ grantId, isActive }: { grantId: string; isActive: boolean }) {
  if (!isActive) return <span className="text-xs text-slate-400">Preserved</span>
  return (
    <PlatformMutationButton
      action={revokeAccessAction.bind(null, grantId)}
      success="Cross-organization access revoked"
      size="sm"
      variant="ghost"
    >
      Revoke
    </PlatformMutationButton>
  )
}

/** The empty grants card body. */
export function NoGrantsBody() {
  return (
    <CardContent className="p-5 text-sm text-slate-500 dark:text-slate-400">
      No explicit cross-organization grants.
    </CardContent>
  )
}

/**
 * The identity fact card.
 *
 * One widget rather than a frame plus a repeat: every row is a label over a
 * value with one of two treatments, and the card's header is a `CardTitle`
 * component. Naming five facts as data is honest; naming the card's internal
 * chrome as blocks would only re-describe the component.
 */
export function IdentityRecordCard({
  title,
  facts,
}: {
  title: string
  facts: { label: string; value: string; mono?: boolean }[]
}) {
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {facts.map((fact) => (
          <Fact key={fact.label} label={fact.label} value={fact.value} mono={fact.mono ?? false} />
        ))}
      </CardContent>
    </Card>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={
          mono
            ? 'mt-1 break-all font-mono text-xs text-slate-700 dark:text-slate-200'
            : 'mt-1 text-slate-800 dark:text-slate-200'
        }
      >
        {value}
      </div>
    </div>
  )
}

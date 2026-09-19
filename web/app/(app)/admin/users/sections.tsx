import { Badge } from '@openbooks/ui'
import { SortTh } from '../../../../components/sortable-th'
import { RoleAssignmentButton, ActiveToggle, ResendInviteButton, LinkPersonButton } from './UserActions'

export interface AdminUserRow {
  id: string
  name: string
  email: string
  isActive: boolean
  isSelf: boolean
  /** Invited but never signed in while a set-password link is outstanding. */
  isPending: boolean
  statusLabel: string
  statusVariant: 'success' | 'destructive' | 'warning'
  lastSignIn: string
  assigned: { id: string; name: string }[]
  /** Native linked person (users.party_id) with display evidence, if any. */
  partyId: string | null
  partyName: string | null
  partyKind: string | null
}

/**
 * The org user table.
 *
 * This one is a WIDGET rather than a `table` block, and the reason is worth
 * stating: it is not the shared app table. The native page hand-rolls a plain
 * `<table>` with its own header, divider and hover classes, and the ViewSpec
 * table block deliberately offers only the two real table variants the app
 * has. Expressing this one would mean either teaching the spec to carry a
 * stylesheet or quietly restyling the page — so it stays a component, and the
 * spec places it.
 *
 * Everything around it — the header, the search and filter row, the empty
 * state, the pager — is ordinary spec.
 */
export function AdminUsersTable({
  users,
  allRoles,
  basePath,
  currentParams,
  sort,
  dir,
  labels,
}: {
  users: AdminUserRow[]
  allRoles: { id: string; name: string; isBuiltIn: boolean }[]
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
  labels: {
    name: string
    email: string
    roles: string
    status: string
    lastSignIn: string
    actions: string
    you: string
    unassignedRole: string
    linkedPerson: string
    unlinkedPerson: string
  }
}) {
  const sortProps = { basePath, currentParams, sort, dir }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
            <SortTh column="name" {...sortProps}>
              {labels.name}
            </SortTh>
            <SortTh column="email" {...sortProps}>
              {labels.email}
            </SortTh>
            <th className="px-3 py-2">{labels.roles}</th>
            <th className="px-3 py-2">{labels.linkedPerson}</th>
            <th className="px-3 py-2">{labels.status}</th>
            <SortTh column="last_login" {...sortProps}>
              {labels.lastSignIn}
            </SortTh>
            <th className="px-3 py-2 text-right">{labels.actions}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
              <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                {u.name}
                {u.isSelf ? (
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    {labels.you}
                  </Badge>
                ) : null}
              </td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{u.email}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                  {u.assigned.length === 0 ? (
                    <Badge variant="warning" className="text-[10px]">
                      {labels.unassignedRole}
                    </Badge>
                  ) : (
                    u.assigned.map((r) => (
                      <Badge key={r.id} variant="outline">
                        {r.name}
                      </Badge>
                    ))
                  )}
                  <RoleAssignmentButton
                    userId={u.id}
                    userName={u.name}
                    allRoles={allRoles}
                    assignedRoleIds={u.assigned.map((r) => r.id)}
                  />
                </div>
              </td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                {u.partyId && u.partyName ? (
                  <span>
                    {u.partyName}
                    {u.partyKind ? (
                      <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">{u.partyKind}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-slate-400 dark:text-slate-500">{labels.unlinkedPerson}</span>
                )}
              </td>
              <td className="px-3 py-2">
                <Badge variant={u.statusVariant}>{u.statusLabel}</Badge>
              </td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{u.lastSignIn}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <LinkPersonButton
                    userId={u.id}
                    userName={u.name}
                    partyId={u.partyId}
                    partyName={u.partyName}
                    isSelf={u.isSelf}
                  />
                  <ResendInviteButton
                    userId={u.id}
                    userEmail={u.email}
                    isPending={u.isPending}
                  />
                  <ActiveToggle
                    userId={u.id}
                    userName={u.name}
                    isActive={u.isActive}
                    isSelf={u.isSelf}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

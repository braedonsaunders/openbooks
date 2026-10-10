import { RegisteredListTable } from '../../../../components/registered-list-table'
import { Badge } from '@openbooks/ui'
import { SortTh } from '../../../../components/sortable-th'
import {
  RoleAssignmentButton,
  ActiveToggle,
  ResendInviteButton,
  LinkPersonButton,
} from './UserActions'

export interface AdminUserRow {
  id: string
  name: string
  email: string
  isActive: boolean
  isSelf: boolean
  /** The viewer is the sole active user administrator and may link their own login. */
  selfLinkAllowed: boolean
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

/** Native record cells and actions compose the shared table primitives. */
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
    <RegisteredListTable
      source="admin_users"
      rows={users}
      rowKey={(u) => u.id}
      empty=""
      rowClassName={() => 'hover:bg-slate-50/50 dark:hover:bg-slate-800/60'}
      columns={[
        {
          key: 'column_0',
          header: <>{labels.name}</>,
          headerCell: (
            <SortTh column="name" {...sortProps}>
              {labels.name}
            </SortTh>
          ),
          className: 'px-3 py-2 font-medium text-slate-900 dark:text-slate-100',
          cell: (u) => (
            <>
              {u.name}
              {u.isSelf ? (
                <Badge variant="secondary" className="ml-2 text-[10px]">
                  {labels.you}
                </Badge>
              ) : null}
            </>
          ),
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_1',
          header: <>{labels.email}</>,
          headerCell: (
            <SortTh column="email" {...sortProps}>
              {labels.email}
            </SortTh>
          ),
          className: 'px-3 py-2 text-slate-600 dark:text-slate-400',
          cell: (u) => <>{u.email}</>,
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_2',
          header: <>{labels.roles}</>,
          headerClassName: 'px-3 py-2',
          className: 'px-3 py-2',
          cell: (u) => (
            <>
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
            </>
          ),
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_3',
          header: <>{labels.linkedPerson}</>,
          headerClassName: 'px-3 py-2',
          className: 'px-3 py-2 text-slate-600 dark:text-slate-400',
          cell: (u) => (
            <>
              {u.partyId && u.partyName ? (
                <span>
                  {u.partyName}
                  {u.partyKind ? (
                    <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                      {u.partyKind}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-slate-400 dark:text-slate-500">
                  {labels.unlinkedPerson}
                </span>
              )}
            </>
          ),
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_4',
          header: <>{labels.status}</>,
          headerClassName: 'px-3 py-2',
          className: 'px-3 py-2',
          cell: (u) => (
            <>
              <Badge variant={u.statusVariant}>{u.statusLabel}</Badge>
            </>
          ),
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_5',
          header: <>{labels.lastSignIn}</>,
          headerCell: (
            <SortTh column="last_login" {...sortProps}>
              {labels.lastSignIn}
            </SortTh>
          ),
          className: 'px-3 py-2 text-slate-600 dark:text-slate-400',
          cell: (u) => <>{u.lastSignIn}</>,
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_6',
          header: <>{labels.actions}</>,
          headerClassName: 'px-3 py-2 text-right',
          className: 'px-3 py-2 text-right',
          cell: (u) => (
            <>
              <div className="flex items-center justify-end gap-2">
                <LinkPersonButton
                  userId={u.id}
                  userName={u.name}
                  partyId={u.partyId}
                  partyName={u.partyName}
                  isSelf={u.isSelf}
                  selfLinkAllowed={u.selfLinkAllowed}
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
            </>
          ),
          search: (u) =>
            Object.values(u)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
      ]}
    />
  )
}

import { RegisteredListTable } from '../../../../components/registered-list-table'
import { Badge } from '@openbooks/ui'
import { SortTh } from '../../../../components/sortable-th'
import {
  EditRoleButton,
  type RoleRow,
  type SubsidiaryPickerOption,
} from './RoleEditor'

export interface AdminRoleRow extends RoleRow {
  permissionCount: number
  memberCount: number
}

/** Native record cells and actions compose the shared table primitives. */
export function AdminRolesTable({
  roles,
  subsidiaries,
  basePath,
  currentParams,
  sort,
  dir,
  labels,
}: {
  roles: AdminRoleRow[]
  subsidiaries: SubsidiaryPickerOption[] | null
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
  labels: {
    name: string
    key: string
    description: string
    permissions: string
    members: string
    type: string
    actions: string
    builtIn: string
    custom: string
    noDescription: string
  }
}) {
  const sortProps = { basePath, currentParams, sort, dir }
  return (
    <RegisteredListTable
      source="admin_roles"
      rows={roles}
      rowKey={(r) => r.id}
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
          cell: (r) => <>{r.name}</>,
          search: (r) =>
            Object.values(r)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_1',
          header: <>{labels.key}</>,
          headerClassName: 'px-3 py-2',
          className:
            'px-3 py-2 font-mono text-[13px] text-slate-600 dark:text-slate-400',
          cell: (r) => <>{r.key}</>,
          search: (r) =>
            Object.values(r)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_2',
          header: <>{labels.description}</>,
          headerClassName: 'px-3 py-2',
          className: 'max-w-md px-3 py-2 text-slate-600 dark:text-slate-400',
          cell: (r) => (
            <>
              <span className="line-clamp-1">
                {r.description ?? labels.noDescription}
              </span>
            </>
          ),
          search: (r) =>
            Object.values(r)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_3',
          header: <>{labels.permissions}</>,
          headerCell: (
            <SortTh column="permissions" {...sortProps}>
              {labels.permissions}
            </SortTh>
          ),
          className:
            'px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400',
          cell: (r) => <>{r.permissionCount}</>,
          search: (r) =>
            Object.values(r)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_4',
          header: <>{labels.members}</>,
          headerCell: (
            <SortTh column="members" {...sortProps}>
              {labels.members}
            </SortTh>
          ),
          className:
            'px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400',
          cell: (r) => <>{r.memberCount}</>,
          search: (r) =>
            Object.values(r)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_5',
          header: <>{labels.type}</>,
          headerClassName: 'px-3 py-2',
          className: 'px-3 py-2',
          cell: (r) => (
            <>
              {r.isBuiltIn ? (
                <Badge variant="secondary">{labels.builtIn}</Badge>
              ) : (
                <Badge variant="outline">{labels.custom}</Badge>
              )}
            </>
          ),
          search: (r) =>
            Object.values(r)
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
          cell: (r) => (
            <>
              <EditRoleButton role={r} subsidiaries={subsidiaries} />
            </>
          ),
          search: (r) =>
            Object.values(r)
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

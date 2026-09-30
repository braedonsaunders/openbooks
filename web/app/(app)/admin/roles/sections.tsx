import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { Badge } from '@openbooks/ui'
import { SortTh } from '../../../../components/sortable-th'
import { EditRoleButton, type RoleRow, type SubsidiaryPickerOption } from './RoleEditor'

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
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SharedTable className="w-full text-sm">
        <SharedTableHeader>
          <SharedTableRow className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
            <SortTh column="name" {...sortProps}>
              {labels.name}
            </SortTh>
            <SharedTableHead className="px-3 py-2">{labels.key}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{labels.description}</SharedTableHead>
            <SortTh column="permissions" {...sortProps}>
              {labels.permissions}
            </SortTh>
            <SortTh column="members" {...sortProps}>
              {labels.members}
            </SortTh>
            <SharedTableHead className="px-3 py-2">{labels.type}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right">{labels.actions}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody className="divide-y divide-slate-100 dark:divide-slate-800">
          {roles.map((r) => (
            <SharedTableRow key={r.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
              <SharedTableCell className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                {r.name}
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2 font-mono text-[13px] text-slate-600 dark:text-slate-400">
                {r.key}
              </SharedTableCell>
              <SharedTableCell className="max-w-md px-3 py-2 text-slate-600 dark:text-slate-400">
                <span className="line-clamp-1">{r.description ?? labels.noDescription}</span>
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                {r.permissionCount}
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                {r.memberCount}
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2">
                {r.isBuiltIn ? (
                  <Badge variant="secondary">{labels.builtIn}</Badge>
                ) : (
                  <Badge variant="outline">{labels.custom}</Badge>
                )}
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2 text-right">
                <EditRoleButton role={r} subsidiaries={subsidiaries} />
              </SharedTableCell>
            </SharedTableRow>
          ))}
        </SharedTableBody>
      </SharedTable>
    </div>
  )
}

import { Badge } from '@openbooks/ui'
import { SortTh } from '../../../../components/sortable-th'
import { EditRoleButton, type RoleRow, type SubsidiaryPickerOption } from './RoleEditor'

export interface AdminRoleRow extends RoleRow {
  permissionCount: number
  memberCount: number
}

/**
 * The org role table.
 *
 * This one is a WIDGET rather than a `table` block, and the reason is worth
 * stating: it is not the shared app table. The native page hand-rolls a
 * plain `<table>` with its own header, divider and hover classes — plus a
 * font-mono key column, a line-clamped description, tabular-nums counts,
 * type badges and per-row editor buttons the spec's table vocabulary
 * cannot name. Expressing this one would mean either teaching the spec to
 * carry a stylesheet or quietly restyling the page — so it stays a
 * component, and the spec places it.
 *
 * Everything around it — the header, the search and filter row, the empty
 * state, the pager — is ordinary spec.
 */
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
            <SortTh column="name" {...sortProps}>
              {labels.name}
            </SortTh>
            <th className="px-3 py-2">{labels.key}</th>
            <th className="px-3 py-2">{labels.description}</th>
            <SortTh column="permissions" {...sortProps}>
              {labels.permissions}
            </SortTh>
            <SortTh column="members" {...sortProps}>
              {labels.members}
            </SortTh>
            <th className="px-3 py-2">{labels.type}</th>
            <th className="px-3 py-2 text-right">{labels.actions}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {roles.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
              <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                {r.name}
              </td>
              <td className="px-3 py-2 font-mono text-[13px] text-slate-600 dark:text-slate-400">
                {r.key}
              </td>
              <td className="max-w-md px-3 py-2 text-slate-600 dark:text-slate-400">
                <span className="line-clamp-1">{r.description ?? labels.noDescription}</span>
              </td>
              <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                {r.permissionCount}
              </td>
              <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                {r.memberCount}
              </td>
              <td className="px-3 py-2">
                {r.isBuiltIn ? (
                  <Badge variant="secondary">{labels.builtIn}</Badge>
                ) : (
                  <Badge variant="outline">{labels.custom}</Badge>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <EditRoleButton role={r} subsidiaries={subsidiaries} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

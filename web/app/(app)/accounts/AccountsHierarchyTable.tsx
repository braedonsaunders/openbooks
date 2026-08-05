'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, BookOpenText } from 'lucide-react'
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { AccountRegisterLink } from '../../../components/account-register-link'

export interface HierarchyAccountRow {
  id: string
  parentId: string | null
  number: string
  name: string
  typeLabel: string
  isSummary: boolean
  isActive: boolean
  balance: string
  balanceNegative: boolean
  detailHref: string
}

export interface HierarchyAccountGroup {
  key: string
  label: string
  count: number
  balance: string
  balanceNegative: boolean
  rows: HierarchyAccountRow[]
}

export function AccountsHierarchyTable({
  groups,
  labels,
}: {
  groups: HierarchyAccountGroup[]
  labels: {
    account: string
    type: string
    balance: string
    actions: string
    inactive: string
    viewRegister: string
    expand: string
    collapse: string
  }
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function visibleRows(rows: HierarchyAccountRow[]) {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const depthOf = (row: HierarchyAccountRow) => {
      let depth = 0
      let parentId = row.parentId
      const visited = new Set<string>()
      while (parentId && byId.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId)
        depth += 1
        parentId = byId.get(parentId)?.parentId ?? null
      }
      return depth
    }
    const hiddenByCollapsedParent = (row: HierarchyAccountRow) => {
      let parentId = row.parentId
      const visited = new Set<string>()
      while (parentId && byId.has(parentId) && !visited.has(parentId)) {
        if (collapsed.has(parentId)) return true
        visited.add(parentId)
        parentId = byId.get(parentId)?.parentId ?? null
      }
      return false
    }
    return rows
      .filter((row) => !hiddenByCollapsedParent(row))
      .map((row) => ({ row, depth: depthOf(row) }))
  }

  return (
    <Table className="min-w-[760px] table-fixed">
      <TableHeader>
        <TableRow noAnimate>
          <TableHead className="w-[52%]">{labels.account}</TableHead>
          <TableHead className="w-[24%]">{labels.type}</TableHead>
          <TableHead className="w-[16%] text-right">{labels.balance}</TableHead>
          <TableHead className="w-[8%] text-right">
            <span className="sr-only">{labels.actions}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <GroupRows
            key={group.key}
            group={group}
            rows={visibleRows(group.rows)}
            collapsed={collapsed}
            onToggle={toggle}
            labels={labels}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function GroupRows({
  group,
  rows,
  collapsed,
  onToggle,
  labels,
}: {
  group: HierarchyAccountGroup
  rows: { row: HierarchyAccountRow; depth: number }[]
  collapsed: Set<string>
  onToggle: (id: string) => void
  labels: {
    inactive: string
    viewRegister: string
    expand: string
    collapse: string
  }
}) {
  return (
    <>
      <TableRow
        noAnimate
        className="border-y border-slate-200 bg-slate-100/90 hover:bg-slate-100/90 dark:border-slate-700 dark:bg-slate-800/90 dark:hover:bg-slate-800/90"
      >
        <TableCell colSpan={2} className="py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-bold tracking-[0.08em] text-slate-700 uppercase dark:text-slate-200">
              {group.label}
            </span>
            <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">{group.count}</span>
          </div>
        </TableCell>
        <TableCell className={cn(
          'py-2.5 text-right text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200',
          group.balanceNegative && 'text-red-600 dark:text-red-400',
        )}>
          {group.balance}
        </TableCell>
        <TableCell className="py-2.5" />
      </TableRow>
      {rows.map(({ row, depth }) => {
        const isCollapsed = collapsed.has(row.id)
        return (
          <TableRow
            key={row.id}
            className={cn(
              'group',
              row.isSummary && 'bg-slate-50/45 dark:bg-slate-900/45',
              !row.isActive && 'opacity-65',
            )}
          >
            <TableCell className="py-2.5">
              <div className="flex min-w-0 items-center" style={{ paddingLeft: `${Math.min(depth, 6) * 20}px` }}>
                {row.isSummary ? (
                  <button
                    type="button"
                    onClick={() => onToggle(row.id)}
                    aria-label={isCollapsed ? labels.expand : labels.collapse}
                    aria-expanded={!isCollapsed}
                    className="mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                  >
                    {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                  </button>
                ) : (
                  <span className="mr-1.5 h-6 w-6 shrink-0" aria-hidden />
                )}
                <span className="mr-3 w-20 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {row.number}
                </span>
                <Link
                  href={row.detailHref as never}
                  className={cn(
                    'min-w-0 truncate hover:text-teal-700 hover:underline dark:hover:text-teal-300',
                    row.isSummary && 'font-semibold text-slate-900 dark:text-slate-100',
                  )}
                >
                  {row.name}
                </Link>
                {!row.isActive ? <Badge variant="outline" className="ml-2 shrink-0">{labels.inactive}</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="truncate py-2.5 text-xs text-slate-500 dark:text-slate-400">
              {row.typeLabel}
            </TableCell>
            <TableCell className={cn(
              'py-2.5 text-right font-medium tabular-nums',
              row.balanceNegative && 'text-red-600 dark:text-red-400',
              row.isSummary && 'font-semibold',
            )}>
              {row.balance}
            </TableCell>
            <TableCell className="py-2.5 text-right">
              <AccountRegisterLink
                accountId={row.id}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 opacity-70 transition-colors group-hover:opacity-100 hover:bg-slate-100 hover:text-teal-700 dark:hover:bg-slate-800 dark:hover:text-teal-300"
                ariaLabel={`${labels.viewRegister}: ${row.number} ${row.name}`}
                title={labels.viewRegister}
              >
                <BookOpenText size={15} />
              </AccountRegisterLink>
            </TableCell>
          </TableRow>
        )
      })}
    </>
  )
}

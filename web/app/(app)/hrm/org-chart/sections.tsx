'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, UrlDrawer } from '@openbooks/ui'
import type { loadOrgChartHome } from '../../../../lib/hrm/org-chart-home'

/**
 * Org-chart tree widget + person drawer (0230, HR-19).
 *
 * ONE ViewSpec widget ('org-chart-tree'): collapsible nodes, vacancy
 * nodes dashed, the as-of date picker, department colour dots, span
 * and layer badges, search-to-node (matching nodes expand into view),
 * keyboard navigation (buttons, focus-visible outlines, aria-expanded),
 * and a card-stack fallback under 640px. Clicking a node navigates the
 * `person` param — the person drawer closes by navigation. No org id,
 * user id, or Authz crosses into the widget: hrefs arrive
 * loader-resolved.
 */

type Home = NonNullable<Awaited<ReturnType<typeof loadOrgChartHome>>>
type Chart = Home['chart']
type Node = Chart['roots'][number]

function msg(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key
}

const DEPARTMENT_HUES: Record<string, string> = {}

function departmentColor(department: string | null): string {
  if (!department) return '#64748b'
  let hue = DEPARTMENT_HUES[department]
  if (hue === undefined) {
    let hash = 0
    for (let i = 0; i < department.length; i++) hash = (hash * 31 + department.charCodeAt(i)) % 360
    hue = `hsl(${hash} 60% 45%)`
    DEPARTMENT_HUES[department] = hue
  }
  return hue
}

function collectMatches(nodes: Node[], query: string, acc: Set<string>): void {
  for (const node of nodes) {
    if (
      query.length > 0 &&
      (node.name.toLowerCase().includes(query) ||
        (node.title ?? '').toLowerCase().includes(query) ||
        (node.department ?? '').toLowerCase().includes(query))
    ) {
      acc.add(node.employmentId ?? `vacant:${node.positionId}`)
    }
    collectMatches(node.children, query, acc)
  }
}

function TreeNode({
  node,
  depth,
  baseHref,
  collapsed,
  toggle,
  expandMatched,
  search,
  labels,
}: {
  node: Node
  depth: number
  baseHref: string
  collapsed: Set<string>
  toggle: (key: string) => void
  expandMatched: Set<string>
  search: string
  labels: Record<string, string>
}) {
  const router = useRouter()
  const key = node.employmentId ?? `vacant:${node.positionId}`
  const isCollapsed = collapsed.has(key) && !expandMatched.has(key)
  const match = search.length > 0 && expandMatched.has(key)
  const hasChildren = node.children.length > 0

  function openPerson() {
    if (node.employmentId) router.push(`${baseHref}&person=${node.employmentId}`)
  }

  return (
    <li className="flex flex-col gap-1">
      <div
        className={`flex items-center gap-2 rounded-md border p-2 text-left sm:min-w-56 ${
          node.vacant ? 'border-dashed' : ''
        } ${match ? 'ring-2 ring-amber-400' : ''}`}
      >
        {hasChildren && (
          <button
            type="button"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? msg(labels, 'expand') : msg(labels, 'collapse')}
            onClick={() => toggle(key)}
            className="rounded px-1 text-lg leading-none focus-visible:outline-2"
          >
            {isCollapsed ? '+' : '−'}
          </button>
        )}
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: departmentColor(node.department) }}
        />
        <button type="button" onClick={node.employmentId ? openPerson : undefined} className="min-w-0 flex-1 text-left focus-visible:outline-2" disabled={!node.employmentId}>
          <span className="block truncate text-sm font-medium">
            {node.vacant ? msg(labels, 'vacant') : node.name}
          </span>
          <span className="block truncate text-xs text-slate-500">
            {[node.title ?? node.positionCode, node.department].filter(Boolean).join(' · ')}
          </span>
        </button>
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs tabular-nums dark:bg-slate-800" title={msg(labels, 'span')}>
          {node.spanOfControl}
        </span>
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="ml-4 flex flex-col gap-1 border-l pl-2 sm:ml-6">
          {node.children.map((child) => (
            <TreeNode
              key={child.employmentId ?? `vacant:${child.positionId}`}
              node={child}
              depth={depth + 1}
              baseHref={baseHref}
              collapsed={collapsed}
              toggle={toggle}
              expandMatched={expandMatched}
              search={search}
              labels={labels}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function OrgChartTree({
  chart,
  search,
  asOf,
  today,
  personBaseHref,
  asOfLabel,
  searchLabel,
  labels,
}: {
  chart: Chart
  search: string
  asOf: string
  today: string
  personBaseHref: string
  asOfLabel: string
  searchLabel: string
  labels: Record<string, string>
}) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const query = search.trim().toLowerCase()

  const expandMatched = useMemo(() => {
    const acc = new Set<string>()
    collectMatches(chart.roots, query, acc)
    return acc
  }, [chart, query])

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Card-stack fallback under 640px: the same nodes as cards. The tree
  // above stays usable at 390px (horizontal scroll within its panel);
  // the stack is the narrow-screen reading order. Both render from the
  // same loader rows — no second source.
  function flatten(nodes: Node[], acc: Node[]): Node[] {
    for (const node of nodes) {
      acc.push(node)
      flatten(node.children, acc)
    }
    return acc
  }
  const flat = useMemo(() => flatten(chart.roots, []), [chart])
  const visible = query.length === 0 ? flat : flat.filter((n) => expandMatched.has(n.employmentId ?? `vacant:${n.positionId}`))

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-3"
        action="/hrm/org-chart"
        method="get"
        onSubmit={(e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          const next = new URLSearchParams()
          const asOfValue = String(data.get('asOf') ?? asOf)
          const q = String(data.get('q') ?? '').trim()
          if (asOfValue) next.set('asOf', asOfValue)
          if (q) next.set('q', q)
          router.push(`/hrm/org-chart?${next.toString()}`)
        }}
      >
        <div>
          <Label>{asOfLabel}</Label>
          <Input type="date" name="asOf" defaultValue={asOf} max={today} />
        </div>
        <div>
          <Label>{searchLabel}</Label>
          <Input type="search" name="q" defaultValue={search} />
        </div>
        <Button type="submit">{searchLabel}</Button>
      </form>
      {visible.length === 0 && query.length > 0 && (
        <p className="text-sm text-slate-500">{msg(labels, 'noMatch')}</p>
      )}
      <div className="min-h-0 overflow-auto">
        <ul className="hidden flex-col gap-1 sm:flex">
          {chart.roots.map((root) => (
            <TreeNode
              key={root.employmentId ?? `vacant:${root.positionId}`}
              node={root}
              depth={0}
              baseHref={personBaseHref}
              collapsed={collapsed}
              toggle={toggle}
              expandMatched={expandMatched}
              search={query}
              labels={labels}
            />
          ))}
        </ul>
        <ul className="flex flex-col gap-2 sm:hidden">
          {visible.map((node) => (
            <li
              key={node.employmentId ?? `vacant:${node.positionId}`}
              className={`rounded-md border p-3 ${node.vacant ? 'border-dashed' : ''}`}
            >
              <p className="text-sm font-medium">{node.vacant ? msg(labels, 'vacant') : node.name}</p>
              <p className="text-xs text-slate-500">
                {[node.title ?? node.positionCode, node.department].filter(Boolean).join(' · ')}
              </p>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                {msg(labels, 'span')}: {node.spanOfControl}
              </p>
              {node.employmentId && (
                <Button
                  variant="outline"
                  onClick={() => router.push(`${personBaseHref}&person=${node.employmentId}`)}
                >
                  {node.name}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function OrgChartPerson({
  selected,
  closeHref,
  labels,
}: {
  selected: Home['selected']
  closeHref: string
  labels: Record<string, string>
}) {
  if (!selected) return null
  return (
    <UrlDrawer open closeHref={closeHref} title={selected.name}>
      <div className="flex flex-col gap-2 text-sm">
        {selected.title && (
          <p>
            <span className="text-slate-500">{msg(labels, 'department')}: </span>
            {[selected.title, selected.department].filter(Boolean).join(' · ')}
          </p>
        )}
        <p>
          <span className="text-slate-500">{msg(labels, 'reports')}: </span>
          <span className="tabular-nums">{selected.spanOfControl}</span>
        </p>
        {selected.children.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {selected.children.map((child) => (
              <li key={child.employmentId ?? `vacant:${child.positionId}`}>
                {child.vacant ? msg(labels, 'vacant') : child.name}
                {child.title ? ` — ${child.title}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </UrlDrawer>
  )
}

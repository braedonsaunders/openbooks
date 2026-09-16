'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Lock } from 'lucide-react'

/** Opens posted GL impact as a stacked drawer without leaving its source record. */
export function JournalEntryLink({
  entryId,
  className,
  children,
}: {
  entryId: string
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? '/'
  const current = useSearchParams()
  const params = new URLSearchParams(current.toString())
  params.set('txn', entryId)
  return (
    <Link href={`${pathname}?${params}` as never} className={className} scroll={false}>
      {children}
    </Link>
  )
}

/** A journal line carrying the contributor stamps the posting kernel wrote. */
export interface ContributorGroupedLine {
  line_number: number
  contributor_kind: string | null
  contributor_ref: string | null
  contributor_name: string | null
}

export interface ContributorGroup<T extends ContributorGroupedLine> {
  key: string
  /** Null for the kernel's own standard lines. */
  kind: string | null
  ref: string | null
  name: string | null
  lines: T[]
}

/**
 * Group GL lines by contributor for the impact drawer: standard kernel lines
 * first, then one group per rule/script/app in first-appearance order. Pure
 * and db-free so entry views share it without touching the ledger.
 */
export function groupEntryLinesByContributor<T extends ContributorGroupedLine>(lines: T[]): ContributorGroup<T>[] {
  const standard: ContributorGroup<T> = { key: 'standard', kind: null, ref: null, name: null, lines: [] }
  const groups: ContributorGroup<T>[] = []
  const byKey = new Map<string, ContributorGroup<T>>()
  for (const line of lines) {
    if (!line.contributor_kind) {
      standard.lines.push(line)
      continue
    }
    const key = `${line.contributor_kind}:${line.contributor_ref ?? ''}`
    let group = byKey.get(key)
    if (!group) {
      group = { key, kind: line.contributor_kind, ref: line.contributor_ref, name: line.contributor_name, lines: [] }
      byKey.set(key, group)
      groups.push(group)
    } else if (!group.name && line.contributor_name) {
      group.name = line.contributor_name
    }
    group.lines.push(line)
  }
  return [...(standard.lines.length > 0 ? [standard] : []), ...groups]
}

/** Section heading for one contributor group; standard lines render locked. */
export function ContributorGroupHeading({ title, lockedLabel }: { title: string; lockedLabel?: string }) {
  return (
    <div className="flex items-center gap-2 pb-1 pt-3 first:pt-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h4>
      {lockedLabel ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
          <Lock size={11} aria-hidden />
          {lockedLabel}
        </span>
      ) : null}
    </div>
  )
}

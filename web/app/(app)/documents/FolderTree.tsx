'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, Folder as FolderIcon, FolderOpen, FolderPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { useState } from 'react'

export interface TreeFolder {
  id: string
  name: string
  parentId: string | null
  isSystem: boolean
  systemKind: string | null
  isPrivate: boolean
  isInactive: boolean
  recordTable: string | null
  recordId: string | null
  childCount: number
  fileCount: number
}

export function FolderTree({
  folders,
  activeFolderId,
}: {
  folders: TreeFolder[]
  activeFolderId?: string
}) {
  const t = useTranslations('documents')
  const pathname = usePathname()
  const search = useSearchParams()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Build child map
  const childrenOf = (parentId: string | null): TreeFolder[] =>
    folders.filter((f) => f.parentId === parentId)

  // Roots: folders with no parent
  const roots = childrenOf(null)

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function buildHref(folderId: string | null): string {
    const params = new URLSearchParams(search.toString())
    if (folderId) params.set('fid', folderId)
    else params.delete('fid')
    params.delete('page')
    const qs = params.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  function renderNode(folder: TreeFolder, depth: number): React.ReactNode {
    const children = childrenOf(folder.id)
    const isCollapsed = collapsed.has(folder.id)
    const isActive = activeFolderId === folder.id

    return (
      <div key={folder.id}>
        <div
          className={cn(
            'group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm transition-colors',
            isActive
              ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60',
          )}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(folder.id)}
              className="shrink-0 text-slate-400 hover:text-slate-600 dark:text-slate-500"
              aria-label={isCollapsed ? t('folderTree.expand') : t('folderTree.collapse')}
            >
              <ChevronRight
                size={14}
                className={cn('transition-transform', !isCollapsed && 'rotate-90')}
              />
            </button>
          ) : (
            <span className="w-[14px] shrink-0" />
          )}
          <Link
            href={buildHref(folder.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5"
            scroll={false}
          >
            {isCollapsed ? (
              <FolderIcon size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
            ) : (
              <FolderOpen size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
            )}
            <span className="truncate">{folder.name}</span>
            {folder.fileCount > 0 ? (
              <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-400">
                {folder.fileCount}
              </span>
            ) : null}
          </Link>
        </div>
        {!isCollapsed && children.length > 0 ? (
          <div>{children.map((c) => renderNode(c, depth + 1))}</div>
        ) : null}
      </div>
    )
  }

  const allHref = buildHref(null)

  return (
    <div className="hidden w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-900/30 sm:block">
      <Link
        href={allHref}
        scroll={false}
        className={cn(
          'mb-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors',
          !activeFolderId
            ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60',
        )}
      >
        <FolderOpen size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
        <span className="truncate font-medium">{t('list.allFiles')}</span>
      </Link>
      {roots.map((r) => renderNode(r, 0))}
    </div>
  )
}

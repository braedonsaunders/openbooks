'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Download,
  Eye,
  File as FileIcon,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Settings2,
  Trash2,
  UploadCloud,
  Users,
  X,
} from 'lucide-react'
import {
  Badge,
  ContextMenu,
  type ContextMenuEntry,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useContextMenu,
} from '@openbooks/ui'
import { SortTh } from '../../../components/sortable-th'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'

export interface FolderRow {
  id: string
  name: string
  fileCount: number
  isSystem: boolean
}

export interface FileRow {
  id: string
  name: string
  fileType: string
  sizeLabel: string
  modifiedLabel: string
  versionCount: number
  folderName: string | null
}

type Target =
  | { kind: 'file'; row: FileRow }
  | { kind: 'folder'; row: FolderRow }

/** Icon + accent color for a file's derived type. */
function fileIcon(fileType: string) {
  switch (fileType) {
    case 'pdf':
      return { Icon: FileText, className: 'text-rose-500 dark:text-rose-400' }
    case 'image':
      return { Icon: ImageIcon, className: 'text-violet-500 dark:text-violet-400' }
    case 'csv':
    case 'spreadsheet':
      return { Icon: FileSpreadsheet, className: 'text-emerald-500 dark:text-emerald-400' }
    case 'document':
      return { Icon: FileText, className: 'text-blue-500 dark:text-blue-400' }
    case 'text':
      return { Icon: FileCode, className: 'text-amber-500 dark:text-amber-400' }
    default:
      return { Icon: FileIcon, className: 'text-slate-400 dark:text-slate-500' }
  }
}

export function FileList({
  folders,
  files,
  activeFolderId,
  showLocation,
  canEdit,
  canDelete,
  currentParams,
  sort,
  dir,
}: {
  folders: FolderRow[]
  files: FileRow[]
  activeFolderId?: string
  showLocation: boolean
  canEdit: boolean
  canDelete: boolean
  currentParams: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
}) {
  const t = useTranslations('documents')
  const tt = useTranslations('documents.toasts')
  const tb = useTranslations('documents.bulk')
  const tc = useTranslations('common')
  const router = useRouter()
  const search = useSearchParams()

  const menu = useContextMenu()
  const [target, setTarget] = useState<Target | null>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const replaceTargetId = useRef<string | null>(null)

  // --- multi-select ---------------------------------------------------------
  // Selection is keyed by "file:<id>" / "folder:<id>". Only rows the caller can
  // delete are selectable (canDelete gates both), matching the server checks.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const selectable = canDelete
  const rowKeys = [
    ...folders.map((f) => `folder:${f.id}`),
    ...files.map((f) => `file:${f.id}`),
  ]
  const allSelected = rowKeys.length > 0 && rowKeys.every((k) => selected.has(k))

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleAll() {
    setSelected((prev) => (prev.size === rowKeys.length ? new Set() : new Set(rowKeys)))
  }
  function clearSelection() {
    setSelected(new Set())
  }
  const selectedFileIds = () =>
    [...selected].filter((k) => k.startsWith('file:')).map((k) => k.slice(5))
  const selectedFolderIds = () =>
    [...selected].filter((k) => k.startsWith('folder:')).map((k) => k.slice(7))

  async function bulkDownload() {
    const ids = selectedFileIds()
    if (ids.length === 0) {
      toast.error(tb('nothingDownloadable'))
      return
    }
    setBulkBusy(true)
    try {
      const res = await fetch('/api/file-cabinet/bulk-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: ids }),
      })
      if (!res.ok) {
        toast.error(tb('downloadFailed'))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'files.zip'
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulkDelete() {
    const ok = await confirmDialog({
      title: tb('deleteConfirm.title'),
      message: tb('deleteConfirm.body'),
      tone: 'danger',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const res = await fetch('/api/file-cabinet/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          fileIds: selectedFileIds(),
          folderIds: selectedFolderIds(),
        }),
      })
      if (res.ok) {
        const { done } = (await res.json()) as { done: number }
        toast.success(tb('deleted', { count: done }))
        clearSelection()
        router.refresh()
      } else {
        toast.error(tb('deleteFailed'))
      }
    } finally {
      setBulkBusy(false)
    }
  }

  function fileHref(id: string): string {
    return `/documents?file=${id}${activeFolderId ? `&fid=${activeFolderId}` : ''}`
  }

  function folderHref(id: string): string {
    const p = new URLSearchParams()
    for (const key of ['q', 'sort', 'dir', 'perPage'] as const) {
      const v = currentParams[key]
      if (typeof v === 'string' && v) p.set(key, v)
    }
    p.set('fid', id)
    return `/documents?${p.toString()}`
  }

  /** Open a folder's properties/sharing drawer (keeps the current location). */
  function folderPropsHref(id: string, folderTab?: string): string {
    const p = new URLSearchParams()
    if (activeFolderId) p.set('fid', activeFolderId)
    p.set('folder', id)
    if (folderTab) p.set('folderTab', folderTab)
    return `/documents?${p.toString()}`
  }

  async function copyLink(href: string) {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString())
      toast.success(tt('linkCopied'))
    } catch {
      toast.error(tt('linkCopyFailed'))
    }
  }

  async function renameFile(row: FileRow) {
    const name = await promptDialog({
      title: t('rename.fileTitle'),
      label: t('file.drawer.name'),
      initialValue: row.name,
      confirmLabel: tc('actions.rename'),
    })
    if (!name || name === row.name) return
    const res = await fetch(`/api/file-cabinet/files/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok) {
      toast.success(tt('fileRenamed'))
      router.refresh()
    } else {
      toast.error(tt('fileRenameFailed'))
    }
  }

  async function renameFolder(row: FolderRow) {
    const name = await promptDialog({
      title: t('rename.folderTitle'),
      label: t('folder.edit.nameLabel'),
      initialValue: row.name,
      confirmLabel: tc('actions.rename'),
    })
    if (!name || name === row.name) return
    const res = await fetch(`/api/file-cabinet/folders/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok) {
      toast.success(tt('folderRenamed'))
      router.refresh()
    } else {
      toast.error(tt('folderRenameFailed'))
    }
  }

  async function deleteFile(row: FileRow) {
    const ok = await confirmDialog({
      title: t('file.drawer.delete.title'),
      message: t('file.drawer.delete.body'),
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(`/api/file-cabinet/files/${row.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(tt('fileDeleted'))
      // If the deleted file's flyout is open, close it.
      if (search.get('file') === row.id) {
        const p = new URLSearchParams(search.toString())
        p.delete('file')
        router.push(p.toString() ? `/documents?${p.toString()}` : '/documents')
      }
      router.refresh()
    } else {
      toast.error(tt('fileDeleteFailed'))
    }
  }

  async function deleteFolder(row: FolderRow) {
    const ok = await confirmDialog({
      title: t('folder.delete.title'),
      message: t('folder.delete.body'),
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(`/api/file-cabinet/folders/${row.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(tt('folderDeleted'))
      router.refresh()
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(
        err.error === 'has attached files' ? t('folder.deleteBlocked') : tt('folderDeleteFailed'),
      )
    }
  }

  function startReplace(id: string) {
    replaceTargetId.current = id
    replaceInputRef.current?.click()
  }

  async function handleReplace(fileInput: File) {
    const id = replaceTargetId.current
    if (!id) return
    const form = new FormData()
    form.append('file', fileInput)
    const res = await fetch(`/api/file-cabinet/files/${id}/replace`, { method: 'POST', body: form })
    if (res.ok) {
      toast.success(tt('fileReplaced'))
      router.refresh()
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(err.error ?? tt('fileReplaceFailed'))
    }
  }

  function menuItems(tgt: Target): ContextMenuEntry[] {
    if (tgt.kind === 'folder') {
      const row = tgt.row
      const manageable = canDelete && !row.isSystem
      const items: ContextMenuEntry[] = [
        { key: 'open', label: t('rowMenu.openFolder'), icon: FolderOpen, onSelect: () => router.push(folderHref(row.id)) },
        { key: 'props', label: t('rowMenu.properties'), icon: Settings2, onSelect: () => router.push(folderPropsHref(row.id)) },
        { key: 'copy', label: t('rowMenu.copyLink'), icon: Link2, onSelect: () => void copyLink(folderHref(row.id)) },
      ]
      if (canDelete) {
        items.push({
          key: 'share',
          label: t('rowMenu.manageAccess'),
          icon: Users,
          onSelect: () => router.push(folderPropsHref(row.id, 'sharing')),
        })
      }
      if (manageable) {
        items.push(
          { key: 'sep', separator: true },
          { key: 'rename', label: tc('actions.rename'), icon: Pencil, onSelect: () => void renameFolder(row) },
          { key: 'delete', label: tc('actions.delete'), icon: Trash2, danger: true, onSelect: () => void deleteFolder(row) },
        )
      }
      return items
    }

    const row = tgt.row
    const items: ContextMenuEntry[] = [
      { key: 'open', label: t('rowMenu.open'), icon: Eye, onSelect: () => router.push(fileHref(row.id)) },
      {
        key: 'download',
        label: tc('actions.download'),
        icon: Download,
        onSelect: () => window.open(`/api/file-cabinet/files/${row.id}/download`, '_blank', 'noopener'),
      },
      { key: 'copy', label: t('rowMenu.copyLink'), icon: Link2, onSelect: () => void copyLink(fileHref(row.id)) },
    ]
    if (canDelete) {
      items.push({
        key: 'share',
        label: t('rowMenu.manageAccess'),
        icon: Users,
        onSelect: () =>
          router.push(
            `/documents?file=${row.id}${activeFolderId ? `&fid=${activeFolderId}` : ''}&fileTab=sharing`,
          ),
      })
    }
    if (canEdit) {
      items.push(
        { key: 'sep1', separator: true },
        { key: 'rename', label: tc('actions.rename'), icon: Pencil, onSelect: () => void renameFile(row) },
        { key: 'replace', label: tc('actions.replace'), icon: UploadCloud, onSelect: () => startReplace(row.id) },
      )
    }
    if (canDelete) {
      items.push(
        { key: 'sep2', separator: true },
        { key: 'delete', label: tc('actions.delete'), icon: Trash2, danger: true, onSelect: () => void deleteFile(row) },
      )
    }
    return items
  }

  function openMenuFor(tgt: Target, e: React.MouseEvent) {
    setTarget(tgt)
    menu.onContextMenu(e)
  }

  function openKebab(tgt: Target, el: HTMLElement) {
    setTarget(tgt)
    menu.openBelow(el)
  }

  const kebabCell = (tgt: Target) => (
    <TableCell className="w-10 text-right">
      <button
        type="button"
        aria-label={tc('actions.more')}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openKebab(tgt, e.currentTarget)
        }}
        className="inline-flex size-7 items-center justify-center rounded text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
    </TableCell>
  )

  return (
    <>
      {selectable && selected.size > 0 ? (
        <div className="sticky top-0 z-20 mb-2 flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm dark:border-teal-900 dark:bg-teal-950/40">
          <span className="font-medium text-teal-800 dark:text-teal-200">
            {tb('selected', { count: selected.size })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => void bulkDownload()}>
              {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {tb('download')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bulkBusy}
              className="text-rose-600 hover:text-rose-700"
              onClick={() => void bulkDelete()}
            >
              <Trash2 className="h-4 w-4" />
              {tb('delete')}
            </Button>
            <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={clearSelection}>
              <X className="h-4 w-4" />
              {tb('clear')}
            </Button>
          </div>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label={tb('selectAll')}
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
              </TableHead>
            ) : null}
            <SortTh basePath="/documents" currentParams={currentParams} column="name" sort={sort} dir={dir}>
              {t('columns.name')}
            </SortTh>
            <TableHead>{t('columns.type')}</TableHead>
            <SortTh basePath="/documents" currentParams={currentParams} column="size" sort={sort} dir={dir} align="right">
              {t('columns.size')}
            </SortTh>
            <SortTh basePath="/documents" currentParams={currentParams} column="created" sort={sort} dir={dir}>
              {t('columns.modified')}
            </SortTh>
            {showLocation ? <TableHead>{t('columns.location')}</TableHead> : null}
            <TableHead className="w-10">
              <span className="sr-only">{tc('actions.more')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
        {folders.map((folder) => {
          const tgt: Target = { kind: 'folder', row: folder }
          return (
            <TableRow key={`folder-${folder.id}`} className="group" onContextMenu={(e) => openMenuFor(tgt, e)}>
              {selectable ? (
                <TableCell className="w-8">
                  <input
                    type="checkbox"
                    aria-label={folder.name}
                    checked={selected.has(`folder:${folder.id}`)}
                    onChange={() => toggle(`folder:${folder.id}`)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                <Link
                  href={folderHref(folder.id)}
                  className="flex items-center gap-2 text-slate-800 hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
                >
                  <FolderIcon className="h-4 w-4 shrink-0 text-teal-500 dark:text-teal-400" />
                  <span className="truncate">{folder.name}</span>
                </Link>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{t('list.folderRow')}</TableCell>
              <TableCell className="text-right tabular-nums text-slate-400 dark:text-slate-500">
                {folder.fileCount > 0 ? t('folder.fileCount', { count: folder.fileCount }) : '—'}
              </TableCell>
              <TableCell className="text-slate-400 dark:text-slate-500">—</TableCell>
              {showLocation ? <TableCell>—</TableCell> : null}
              {kebabCell(tgt)}
            </TableRow>
          )
        })}
        {files.map((f) => {
          const { Icon, className } = fileIcon(f.fileType)
          const tgt: Target = { kind: 'file', row: f }
          return (
            <TableRow key={f.id} className="group" onContextMenu={(e) => openMenuFor(tgt, e)}>
              {selectable ? (
                <TableCell className="w-8">
                  <input
                    type="checkbox"
                    aria-label={f.name}
                    checked={selected.has(`file:${f.id}`)}
                    onChange={() => toggle(`file:${f.id}`)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                <Link
                  href={fileHref(f.id)}
                  className="flex items-center gap-2 text-slate-800 hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
                >
                  <Icon className={`h-4 w-4 shrink-0 ${className}`} />
                  <span className="truncate">{f.name}</span>
                  {f.versionCount > 1 ? (
                    <span className="shrink-0 text-xs text-slate-400">v{f.versionCount}</span>
                  ) : null}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{t(`fileTypes.${f.fileType}`)}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">
                {f.sizeLabel}
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{f.modifiedLabel}</TableCell>
              {showLocation ? (
                <TableCell className="text-slate-500 dark:text-slate-400">{f.folderName ?? '—'}</TableCell>
              ) : null}
              {kebabCell(tgt)}
            </TableRow>
          )
        })}
        </TableBody>
      </Table>

      {target ? (
        <ContextMenu open={menu.open} position={menu.position} onClose={menu.close} items={menuItems(target)} />
      ) : null}

      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleReplace(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

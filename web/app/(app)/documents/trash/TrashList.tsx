'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { File as FileIcon, Folder as FolderIcon, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { confirmDialog } from '../../../../lib/confirm'

export interface TrashRow {
  kind: 'folder' | 'file'
  id: string
  name: string
  fileTypeLabel: string | null
  folderName: string | null
  modifiedLabel: string
}

/** Named purge/restore refusals the file-cabinet routes return, mapped to catalog keys. */
const TRASH_REFUSAL_KEYS = {
  retained_evidence_cannot_be_purged: 'purgeRetained',
  'has attached files': 'purgeAttached',
  system: 'purgeSystem',
  'not found': 'alreadyGone',
} as const

export function TrashList({ items }: { items: TrashRow[] }) {
  const t = useTranslations('documents.trash')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  function base(row: TrashRow) {
    return `/api/file-cabinet/${row.kind === 'folder' ? 'folders' : 'files'}/${row.id}`
  }

  async function restore(row: TrashRow) {
    setBusy(row.id)
    try {
      const res = await fetch(`${base(row)}/restore`, { method: 'POST' })
      if (res.ok) {
        toast.success(t('restored'))
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        const key = (err.error && TRASH_REFUSAL_KEYS[err.error as keyof typeof TRASH_REFUSAL_KEYS]) ?? 'restoreFailed'
        toast.error(t(key))
      }
    } catch {
      toast.error(t('restoreFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function purge(row: TrashRow) {
    const ok = await confirmDialog({
      title: t('purgeConfirm.title'),
      message: t('purgeConfirm.body'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(row.id)
    try {
      const res = await fetch(`${base(row)}?purge=1`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(t('purged'))
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        const key = (err.error && TRASH_REFUSAL_KEYS[err.error as keyof typeof TRASH_REFUSAL_KEYS]) ?? 'purgeFailed'
        toast.error(t(key))
      }
    } catch {
      toast.error(t('purgeFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('title')}</TableHead>
          <TableHead className="w-40 text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((row) => (
          <TableRow key={`${row.kind}-${row.id}`} className="group">
            <TableCell>
              <div className="flex items-center gap-2">
                {row.kind === 'folder' ? (
                  <FolderIcon className="h-4 w-4 shrink-0 text-teal-500" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <span className="truncate font-medium text-slate-800 dark:text-slate-100">
                  {row.name}
                </span>
                {row.kind === 'folder' ? (
                  <Badge variant="secondary">{t('folderLabel')}</Badge>
                ) : row.fileTypeLabel ? (
                  <Badge variant="secondary">{row.fileTypeLabel}</Badge>
                ) : null}
                {row.folderName ? (
                  <span className="truncate text-xs text-slate-400">
                    {t('inLocation', { location: row.folderName })}
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-slate-400">{row.modifiedLabel}</span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === row.id}
                  onClick={() => void restore(row)}
                >
                  {busy === row.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {t('restore')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-rose-500 hover:text-rose-600"
                  disabled={busy === row.id}
                  aria-label={t('deleteForever')}
                  onClick={() => void purge(row)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

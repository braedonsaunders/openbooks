'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText, Loader2, Paperclip, Trash2, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { dateTime } from '../lib/format'

/**
 * Attachments section for a record drawer. Given a target (table + id), lists
 * existing files (metadata only) and provides a drag-and-drop / file-input
 * uploader. Files are stored in the File Cabinet under an auto-created
 * per-record folder; downloads open the download route in a new tab.
 */

interface AttachedFile {
  id: string
  name: string
  fileType: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
  attachmentId: string
}

const MAX_BYTES = 25 * 1024 * 1024
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.csv,.xlsx,.docx,.txt,' +
  'application/pdf,image/png,image/jpeg,image/gif,text/csv,text/plain,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentPanel({
  targetTable,
  targetId,
  canEdit,
}: {
  targetTable: string
  targetId: string
  canEdit: boolean
}) {
  const t = useTranslations('ui.attachments')
  const tCommon = useTranslations('common')
  const [items, setItems] = useState<AttachedFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/file-cabinet/attachments?targetTable=${encodeURIComponent(targetTable)}&targetId=${targetId}`,
    )
    if (res.ok) {
      const data = (await res.json()) as { attachments: AttachedFile[] }
      setItems(data.attachments)
    }
    setLoading(false)
  }, [targetTable, targetId])

  useEffect(() => {
    void load()
  }, [load])

  const uploadOne = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast.error(t('tooLarge', { name: file.name }))
        return
      }
      const form = new FormData()
      form.append('file', file)
      form.append('targetTable', targetTable)
      form.append('targetId', targetId)
      setUploading((n) => n + 1)
      try {
        const res = await fetch('/api/file-cabinet/attachments', { method: 'POST', body: form })
        if (res.ok) {
          const data = (await res.json()) as { attachment: AttachedFile }
          setItems((prev) => [data.attachment, ...prev])
          toast.success(t('attached', { name: file.name }))
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          toast.error(err.error ?? t('attachFailed', { name: file.name }))
        }
      } catch {
        toast.error(t('attachFailed', { name: file.name }))
      } finally {
        setUploading((n) => n - 1)
      }
    },
    [targetTable, targetId, t],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      for (const f of Array.from(files)) void uploadOne(f)
    },
    [uploadOne],
  )

  async function remove(attachmentId: string, name: string) {
    setDeleting(attachmentId)
    try {
      const res = await fetch(`/api/file-cabinet/attachments/${attachmentId}`, { method: 'DELETE' })
      if (res.ok) {
        setItems((prev) => prev.filter((a) => a.attachmentId !== attachmentId))
        toast.success(t('removed', { name }))
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? t('removeFailed'))
      }
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Paperclip className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {tCommon('labels.attachments')}
        </span>
        {items.length > 0 ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">{items.length}</span>
        ) : null}
      </div>

      <div className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> {tCommon('feedback.loading')}
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
        ) : (
          items.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
              <div className="min-w-0 flex-1">
                <a
                  href={`/api/file-cabinet/files/${a.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-sm text-teal-700 hover:underline dark:text-teal-300"
                  title={a.name}
                >
                  {a.name}
                </a>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {formatSize(a.sizeBytes)} · {dateTime(a.createdAt)}
                </p>
              </div>
              <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                <a
                  href={`/api/file-cabinet/files/${a.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('downloadAria', { name: a.name })}
                >
                  <Download className="h-4 w-4" />
                </a>
              </Button>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-500 hover:text-red-600 dark:hover:text-red-400"
                  disabled={deleting === a.attachmentId}
                  onClick={() => remove(a.attachmentId, a.name)}
                  aria-label={t('removeAria', { name: a.name })}
                >
                  {deleting === a.attachmentId ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {canEdit ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFiles(e.dataTransfer.files)
          }}
          className={
            'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-5 text-center text-sm transition-colors ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ' +
            (dragOver
              ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/30'
              : 'border-slate-300 bg-slate-50 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/40 dark:hover:border-slate-600')
          }
        >
          {uploading > 0 ? (
            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('uploading', { count: uploading })}
            </span>
          ) : (
            <>
              <UploadCloud className="h-5 w-5 text-slate-400 dark:text-slate-500" />
              <span className="text-slate-600 dark:text-slate-300">
                {t.rich('dropFiles', {
                  browse: (chunks) => (
                    <span className="text-teal-700 dark:text-teal-300">{chunks}</span>
                  ),
                })}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500">{t('acceptHint')}</span>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

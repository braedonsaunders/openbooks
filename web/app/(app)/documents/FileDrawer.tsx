'use client'

import { useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, FileText, History, Link2, Loader2, Trash2, UploadCloud } from 'lucide-react'
import { Badge, Button, Input, Label, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '../../../lib/confirm'
import { dateTime } from '../../../lib/format'

interface FileVersion {
  id: string
  versionNumber: number
  sizeBytes: number
  contentType: string
  contentHash: string | null
  createdAt: string
  createdBy: string | null
}

interface FileAttachmentLink {
  id: string
  targetTable: string
  targetId: string
  createdAt: string
}

interface FileDetail {
  id: string
  folderId: string
  name: string
  extension: string | null
  fileType: string
  contentType: string
  sizeBytes: number
  isInactive: boolean
  currentVersionId: string | null
  versionCount: number
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
  folderName: string | null
  versions: FileVersion[]
  attachments: FileAttachmentLink[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileDrawer({ file, canManage }: { file: FileDetail; canManage: boolean }) {
  const t = useTranslations('documents.file.drawer')
  const tt = useTranslations('documents.toasts')
  const tc = useTranslations('common')
  const router = useRouter()
  const search = useSearchParams()

  // NetSuite-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // with an Edit button in the header; Save/Cancel replace it while editing.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [name, setName] = useState(file.name)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const replaceInputRef = useRef<HTMLInputElement>(null)

  function closeHref(): string {
    const params = new URLSearchParams(search.toString())
    params.delete('file')
    const qs = params.toString()
    return qs ? `/documents?${qs}` : '/documents'
  }

  async function saveRename() {
    if (!name.trim() || name === file.name) {
      setName(file.name)
      setMode('view')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/file-cabinet/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (res.ok) {
        toast.success(tt('fileRenamed'))
        setMode('view')
        router.refresh()
      } else {
        toast.error(tt('fileRenameFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  function cancelEdit() {
    setName(file.name)
    setMode('view')
  }

  async function handleDelete() {
    if (!(await confirmDialog({ title: t('delete.title'), message: t('delete.body'), tone: 'danger' }))) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/file-cabinet/files/${file.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(tt('fileDeleted'))
        router.push(closeHref())
        router.refresh()
      } else {
        toast.error(tt('fileDeleteFailed'))
      }
    } finally {
      setDeleting(false)
    }
  }

  async function handleReplace(fileInput: File) {
    setReplacing(true)
    const form = new FormData()
    form.append('file', fileInput)
    try {
      const res = await fetch(`/api/file-cabinet/files/${file.id}/replace`, { method: 'POST', body: form })
      if (res.ok) {
        toast.success(tt('fileReplaced'))
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? tt('fileReplaceFailed'))
      }
    } finally {
      setReplacing(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref()}
      title={file.name}
      description={file.folderName ?? undefined}
      size="lg"
      headerActions={
        mode === 'edit' ? (
          <div className="flex items-center gap-2">
            <Button disabled={saving} onClick={saveRename}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {tc('actions.save')}
            </Button>
            <Button variant="outline" disabled={saving} onClick={cancelEdit}>
              {tc('actions.cancel')}
            </Button>
          </div>
        ) : canManage ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setMode('edit')}>
              {tc('actions.edit')}
            </Button>
            <Button variant="ghost" size="icon" asChild>
              <a
                href={`/api/file-cabinet/files/${file.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={tc('actions.download')}
              >
                <Download className="h-4 w-4" />
              </a>
            </Button>
            <Button variant="ghost" size="icon" disabled={deleting} onClick={handleDelete}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon" asChild>
            <a
              href={`/api/file-cabinet/files/${file.id}/download`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={tc('actions.download')}
            >
              <Download className="h-4 w-4" />
            </a>
          </Button>
        )
      }
    >
      <div className="space-y-6">
        {/* File info */}
        <section className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/30 dark:text-teal-400">
              <FileText className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              {mode === 'edit' ? (
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              ) : (
                <h2 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {file.name}
                </h2>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Badge variant="secondary">v{file.versionCount}</Badge>
                <span>{formatSize(file.sizeBytes)}</span>
                <span>·</span>
                <span>{dateTime(file.updatedAt)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Metadata grid */}
        <section className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <Label className="text-xs text-slate-500 dark:text-slate-400">{t('folder')}</Label>
            <p className="text-slate-900 dark:text-slate-100">{file.folderName ?? '—'}</p>
          </div>
          <div>
            <Label className="text-xs text-slate-500 dark:text-slate-400">{t('type')}</Label>
            <p className="text-slate-900 dark:text-slate-100">{file.contentType}</p>
          </div>
          <div>
            <Label className="text-xs text-slate-500 dark:text-slate-400">{t('created')}</Label>
            <p className="text-slate-900 dark:text-slate-100">{dateTime(file.createdAt)}</p>
          </div>
          <div>
            <Label className="text-xs text-slate-500 dark:text-slate-400">{t('modified')}</Label>
            <p className="text-slate-900 dark:text-slate-100">{dateTime(file.updatedAt)}</p>
          </div>
        </section>

        {/* Replace action */}
        {canManage ? (
          <section className="space-y-2">
            <Label>{tc('actions.replace')}</Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={replacing}
                onClick={() => replaceInputRef.current?.click()}
              >
                {replacing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                {tc('actions.replace')}
              </Button>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('replaceBody')}</p>
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
            </div>
          </section>
        ) : null}

        {/* Versions */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            <Label>{t('versions')}</Label>
          </div>
          {file.versions.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('noVersions')}</p>
          ) : (
            <div className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {file.versions.map((v) => (
                <div key={v.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {t('version', { number: v.versionNumber })}
                  </span>
                  {v.id === file.currentVersionId ? (
                    <Badge variant="success">{t('current')}</Badge>
                  ) : null}
                  <span className="ml-auto text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {formatSize(v.sizeBytes)} · {dateTime(v.createdAt)}
                  </span>
                  <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                    <a
                      href={`/api/file-cabinet/files/${file.id}/download?versionId=${v.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={tc('actions.download')}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Attached to records */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            <Label>{t('attachedTo')}</Label>
          </div>
          {file.attachments.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('notAttached')}</p>
          ) : (
            <div className="space-y-1">
              {file.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <Badge variant="outline">{a.targetTable}</Badge>
                  <span className="font-mono text-xs">{a.targetId.slice(0, 8)}</span>
                  <span className="text-xs text-slate-400">{dateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </UrlDrawer>
  )
}

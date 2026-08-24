'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, FileQuestion, Loader2, Pencil, Save, X } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'

/** Byte ceiling for loading a text file into the editor (keeps the flyout snappy). */
const TEXT_PREVIEW_LIMIT = 1024 * 1024 // 1 MB

/** Extensions we treat as editable text even when the stored MIME type is generic. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml',
  'html', 'htm', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'sh',
  'bash', 'zsh', 'sql', 'py', 'rb', 'go', 'rs', 'toml', 'ini', 'env', 'conf',
])

interface PreviewFile {
  id: string
  name: string
  contentType: string
  fileType: string
  extension: string | null
  sizeBytes: number
  currentVersionId: string | null
}

type Kind = 'image' | 'pdf' | 'text' | 'unsupported'

function classify(file: PreviewFile): Kind {
  const ct = file.contentType.toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/pdf') return 'pdf'
  if (
    ct.startsWith('text/') ||
    ct === 'application/json' ||
    ct === 'application/xml' ||
    (file.extension != null && TEXT_EXTENSIONS.has(file.extension))
  ) {
    return 'text'
  }
  return 'unsupported'
}

/** Text files can round-trip through the /replace endpoint only when the stored
 *  MIME type is on the upload allowlist; otherwise preview stays read-only. */
function isEditableType(ct: string): boolean {
  const t = ct.split(';')[0]!.trim().toLowerCase()
  return (
    t === 'text/plain' ||
    t === 'text/csv' ||
    t === 'text/markdown' ||
    t === 'text/javascript' ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'text/xml'
  )
}

export function FilePreview({ file, canManage }: { file: PreviewFile; canManage: boolean }) {
  const t = useTranslations('documents.file.preview')
  const tt = useTranslations('documents.toasts')
  const tc = useTranslations('common')
  const router = useRouter()

  const kind = classify(file)
  const downloadUrl = `/api/file-cabinet/files/${file.id}/download`

  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(kind === 'text')
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const tooLarge = file.sizeBytes > TEXT_PREVIEW_LIMIT
  const editable = canManage && isEditableType(file.contentType)

  // (Re)load text whenever the file or its current version changes.
  useEffect(() => {
    if (kind !== 'text' || tooLarge) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    setEditing(false)
    // Default cache mode: the download route sends an ETag + `no-cache`, so the
    // browser revalidates and gets a 304 on reopen instead of re-fetching bytes;
    // a Replace bumps currentVersionId (effect dep) and the new ETag busts it.
    fetch(downloadUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (cancelled) return
        setText(body)
        setOriginal(body)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // currentVersionId changes after a save/replace → refetch fresh bytes.
  }, [kind, tooLarge, downloadUrl, file.currentVersionId])

  async function save() {
    if (text == null) return
    setSaving(true)
    try {
      const ct = file.contentType.split(';')[0]!.trim().toLowerCase()
      const blob = new File([text], file.name, { type: ct })
      const form = new FormData()
      form.append('file', blob)
      const res = await fetch(`/api/file-cabinet/files/${file.id}/replace`, {
        method: 'POST',
        body: form,
      })
      if (res.ok) {
        toast.success(tt('fileReplaced'))
        setOriginal(text)
        setEditing(false)
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? tt('fileReplaceFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setText(original)
    setEditing(false)
  }

  const frame =
    'rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40'

  if (kind === 'image') {
    return (
      <div className={cn(frame, 'flex items-center justify-center p-3')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={downloadUrl}
          alt={file.name}
          className="max-h-[62vh] w-auto max-w-full rounded object-contain"
        />
      </div>
    )
  }

  if (kind === 'pdf') {
    return (
      <div className={cn(frame, 'overflow-hidden p-0')}>
        <iframe src={downloadUrl} title={file.name} className="h-[70vh] w-full" />
      </div>
    )
  }

  if (kind === 'unsupported') {
    return (
      <div
        className={cn(
          frame,
          'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        )}
      >
        <FileQuestion className="h-10 w-10 text-slate-300 dark:text-slate-600" />
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('unsupported')}</p>
        <Button variant="outline" size="sm" asChild>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
            <Download className="h-4 w-4" />
            {tc('actions.download')}
          </a>
        </Button>
      </div>
    )
  }

  // kind === 'text'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {t('title')}
        </span>
        {editable && !tooLarge && !loading && !loadError ? (
          editing ? (
            <div className="flex items-center gap-1.5">
              <Button size="sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {tc('actions.save')}
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={cancel}>
                <X className="h-4 w-4" />
                {tc('actions.cancel')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />
              {tc('actions.edit')}
            </Button>
          )
        ) : null}
      </div>

      {loading ? (
        <div className={cn(frame, 'flex items-center justify-center gap-2 px-6 py-12')}>
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
          <span className="text-sm text-slate-500 dark:text-slate-400">{t('loading')}</span>
        </div>
      ) : tooLarge ? (
        <div className={cn(frame, 'flex flex-col items-center gap-3 px-6 py-10 text-center')}>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('tooLarge')}</p>
          <Button variant="outline" size="sm" asChild>
            <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4" />
              {tc('actions.download')}
            </a>
          </Button>
        </div>
      ) : loadError ? (
        <div className={cn(frame, 'px-6 py-10 text-center')}>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('loadFailed')}</p>
        </div>
      ) : (
        <textarea
          value={text ?? ''}
          readOnly={!editing}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className={cn(
            'app-scroll h-[58vh] w-full resize-none rounded-lg border p-3 font-mono text-xs leading-relaxed text-slate-800 outline-none dark:text-slate-200',
            editing
              ? 'border-teal-400 bg-white ring-2 ring-teal-500/20 dark:border-teal-600 dark:bg-slate-950'
              : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40',
          )}
        />
      )}
    </div>
  )
}

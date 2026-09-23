'use client'

import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Loader2, UploadCloud } from 'lucide-react'
import { Button } from '@openbooks/ui'

const MAX_BYTES = 25 * 1024 * 1024
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.csv,.xlsx,.docx,.txt,.md,.json,.js,.xml,' +
  'application/pdf,image/png,image/jpeg,image/gif,text/csv,text/plain,' +
  'text/markdown,text/javascript,application/json,application/xml,text/xml,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function UploadButton({ folderId }: { folderId?: string }) {
  const t = useTranslations('documents')
  const router = useRouter()
  useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(0)

  async function uploadOne(file: File) {
    if (file.size > MAX_BYTES) {
      toast.error(t('upload.tooLarge', { name: file.name }))
      return
    }
    if (!folderId) {
      toast.error(t('upload.selectFolder'))
      return
    }
    const form = new FormData()
    form.append('file', file)
    form.append('folderId', folderId)
    setUploading((n) => n + 1)
    try {
      const res = await fetch('/api/file-cabinet/files', { method: 'POST', body: form })
      if (res.ok) {
        toast.success(t('toasts.uploaded', { name: file.name }))
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? t('toasts.uploadFailed', { name: file.name }))
      }
    } catch {
      toast.error(t('toasts.uploadFailed', { name: file.name }))
    } finally {
      setUploading((n) => n - 1)
    }
  }

  // No folder selected: the button stays honestly disabled (there is no
  // destination to upload into), but the reason is visible beside it and
  // described to assistive tech — and the folder list is one action away.
  function focusFolderTree(event: ReactMouseEvent) {
    const tree = document.getElementById('documents-folder-tree')
    if (tree) {
      event.preventDefault()
      tree.focus({ preventScroll: false })
      tree.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <>
      <span className="inline-flex items-center gap-2">
      <Button
        variant="default"
        disabled={!folderId || uploading > 0}
        aria-describedby={!folderId ? 'documents-upload-hint' : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {uploading > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
        {uploading > 0 ? t('upload.uploading', { count: uploading }) : t('actions.upload')}
      </Button>
      {!folderId ? (
        <span id="documents-upload-hint" className="text-xs text-slate-500 dark:text-slate-400">
          {t('upload.noFolderHint')}{' '}
          <a
            href="#documents-folder-tree"
            onClick={focusFolderTree}
            className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('upload.selectFolderAction')}
          </a>
        </span>
      ) : null}
      </span>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            for (const f of Array.from(e.target.files)) void uploadOne(f)
          }
          e.target.value = ''
        }}
      />
    </>
  )
}

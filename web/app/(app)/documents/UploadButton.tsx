'use client'

import { useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Loader2, UploadCloud } from 'lucide-react'
import { Button } from '@openbooks/ui'

const MAX_BYTES = 25 * 1024 * 1024
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.csv,.xlsx,.docx,.txt,' +
  'application/pdf,image/png,image/jpeg,image/gif,text/csv,text/plain,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function UploadButton({ folderId }: { folderId?: string }) {
  const t = useTranslations('documents')
  const router = useRouter()
  const search = useSearchParams()
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

  return (
    <>
      <Button
        variant="default"
        disabled={!folderId || uploading > 0}
        onClick={() => inputRef.current?.click()}
      >
        {uploading > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
        {uploading > 0 ? t('upload.uploading', { count: uploading }) : t('actions.upload')}
      </Button>
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

'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { FileUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function CaptureUploadButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations('ap.capture')
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const form = new FormData()
      for (const file of Array.from(files)) form.append('files', file)
      const response = await fetch('/api/ap-capture', { method: 'POST', body: form })
      const body = (await response.json()) as { ids?: string[]; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'upload_failed')
      toast.success(t('uploadComplete', { count: body.ids?.length ?? files.length }))
      router.refresh()
    } catch {
      toast.error(t('uploadFailed'))
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png,image/tiff"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void upload(event.target.files)}
      />
      <Button type="button" disabled={disabled || uploading} onClick={() => input.current?.click()}>
        {uploading ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
        {uploading ? t('uploading') : t('upload')}
      </Button>
    </>
  )
}

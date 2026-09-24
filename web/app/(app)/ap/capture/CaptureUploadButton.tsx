'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { FileUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

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
      // The status is checked before the body parses, and the server's
      // named refusal (not configured, oversized batch) is toasted — never
      // a SyntaxError or a generic fallback that hides the remedy.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('uploadFailed')))
      const body = (await response.json()) as { ids?: string[] }
      toast.success(t('uploadComplete', { count: body.ids?.length ?? files.length }))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('uploadFailed'))
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

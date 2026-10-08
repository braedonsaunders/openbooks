'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Camera, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@openbooks/ui'
import { PartyAvatar } from '../../../components/party-avatar'
import { readApiErrorMessage } from '../../../lib/api-error'
import { confirmDialog } from '../../../lib/confirm'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/** People read as round portraits; companies as square logos. */
export function partyAvatarShape(kind: string | null | undefined): 'round' | 'square' {
  return kind === 'person' || kind === 'employee' ? 'round' : 'square'
}

/**
 * The party's picture in the drawer header. Anyone who reads the record sees
 * it; a manager clicks it to upload a new photo or logo, or removes it. The
 * photo is optional — without one the party shows its initials.
 */
export function PartyPhoto({
  partyId,
  name,
  kind,
  photoFileId,
  canManage,
  onChange,
}: {
  partyId: string | null
  name: string
  kind: string | null | undefined
  photoFileId: string | null
  canManage: boolean
  onChange: (photoFileId: string | null) => void
}) {
  const t = useTranslations('parties.drawer.photo')
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const shape = partyAvatarShape(kind)
  const photoUrl = partyId && photoFileId ? `/api/parties/${encodeURIComponent(partyId)}/photo?v=${encodeURIComponent(photoFileId)}` : null
  const avatar = (
    <PartyAvatar
      name={name}
      photoUrl={photoUrl}
      shape={shape}
      className="h-11 w-11 text-sm shadow-sm ring-2 ring-white dark:ring-slate-900"
    />
  )
  if (!partyId || !canManage) return avatar

  async function upload(file: File) {
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(`/api/parties/${encodeURIComponent(partyId!)}/photo`, { method: 'POST', body: form })
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, t('uploadFailed')))
        return
      }
      const body = await response.json() as { photoFileId: string }
      onChange(body.photoFileId)
      toast.success(t('updated'))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    if (!(await confirmDialog({ message: t('removeConfirm'), confirmLabel: t('remove'), tone: 'danger' }))) return
    setBusy(true)
    try {
      const response = await fetch(`/api/parties/${encodeURIComponent(partyId!)}/photo`, { method: 'DELETE' })
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, t('removeFailed')))
        return
      }
      onChange(null)
      toast.success(t('removed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        aria-label={photoFileId ? t('change') : t('add')}
        title={photoFileId ? t('change') : t('add')}
        className={cn(
          'relative inline-flex focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-wait',
          shape === 'round' ? 'rounded-full' : 'rounded-lg',
        )}
      >
        {avatar}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 grid place-items-center bg-slate-900/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
            shape === 'round' ? 'rounded-full' : 'rounded-lg',
            busy && 'opacity-100',
          )}
        >
          <Camera className={cn('h-4 w-4', busy && 'animate-pulse')} />
        </span>
      </button>
      {photoFileId ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          aria-label={t('remove')}
          title={t('remove')}
          className="absolute -top-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-white text-slate-600 opacity-0 shadow ring-1 ring-slate-200 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-red-600 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
      />
    </span>
  )
}

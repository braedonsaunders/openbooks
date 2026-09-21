'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Input, Label, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Me documents islands (0230, HR-19): per-row sign/acknowledge
 * actions, the export download cell, and the export-my-data dialog.
 * Signing posts the typed name to the own-session sign route (the
 * service resolves the actor's own open signer row — this path never
 * signs for another person). Every fetch branches on res.ok FIRST.
 */

async function post(url: string, body: unknown, failed: string): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    toast.error(await readApiErrorMessage(res, failed))
    return false
  }
  return true
}

export function MeDocumentActions({
  documentId,
  signable,
  acknowledgeable,
  signLabel,
  signNameLabel,
  acknowledgeLabel,
  actionFailed,
}: {
  documentId: string
  signable: boolean
  acknowledgeable: boolean
  signLabel: string
  signNameLabel: string
  acknowledgeLabel: string
  actionFailed: string
}) {
  const router = useRouter()
  const [signing, setSigning] = useState(false)
  const [name, setName] = useState('')

  async function sign() {
    if (await post(`/api/hrm/documents/${documentId}/sign`, { name: name.trim() }, actionFailed)) {
      setSigning(false)
      router.refresh()
    }
  }

  async function acknowledge() {
    if (await post(`/api/hrm/documents/${documentId}/acknowledge`, {}, actionFailed)) router.refresh()
  }

  if (!signable && !acknowledgeable) return null
  return (
    <span className="flex flex-wrap gap-2">
      {signable && !signing && (
        <Button variant="outline" onClick={() => setSigning(true)}>
          {signLabel}
        </Button>
      )}
      {signable && signing && (
        <span className="flex items-center gap-2">
          <Input
            aria-label={signNameLabel}
            placeholder={signNameLabel}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-40"
          />
          <Button onClick={sign} disabled={!name.trim()}>
            {signLabel}
          </Button>
        </span>
      )}
      {acknowledgeable && (
        <Button variant="outline" onClick={acknowledge}>
          {acknowledgeLabel}
        </Button>
      )}
    </span>
  )
}

export function MeExportDownload({
  downloadable,
  href,
  label,
}: {
  downloadable: boolean
  href: string
  label: string
}) {
  if (!downloadable) return null
  return (
    <a href={href} className="text-sm text-teal-700 underline dark:text-teal-300">
      {label}
    </a>
  )
}

export function MeExportDialog({
  partyId,
  requestExportLabel,
  requestExportDone,
  actionFailed,
}: {
  partyId: string
  requestExportLabel: string
  requestExportDone: string
  actionFailed: string
}) {
  const router = useRouter()
  const [done, setDone] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function request() {
    setFailed(null)
    const res = await fetch('/api/hrm/data-subject-exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partyId }),
    })
    if (!res.ok) {
      setFailed(await readApiErrorMessage(res, actionFailed))
      return
    }
    setDone(true)
  }

  return (
    <UrlDrawer open closeHref="/me/documents" title={requestExportLabel}>
      {done ? (
        <p className="text-sm">{requestExportDone}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Label>{requestExportLabel}</Label>
          {failed && <p className="text-sm text-red-600">{failed}</p>}
          <Button
            onClick={() => {
              request().then(() => router.refresh())
            }}
          >
            {requestExportLabel}
          </Button>
        </div>
      )}
    </UrlDrawer>
  )
}

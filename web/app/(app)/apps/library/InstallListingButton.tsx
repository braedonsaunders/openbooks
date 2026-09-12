'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function InstallListingButton({
  listingId,
  name,
  installed,
  current,
  canInstall = true,
}: {
  listingId: string
  name: string
  installed: boolean
  current: boolean
  canInstall?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('apps.library')
  const [busy, setBusy] = useState(false)

  async function install() {
    setBusy(true)
    try {
      const response = await fetch('/api/apps/marketplace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install', listingId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || t('installFailed'))
      toast.success(data.outcome === 'pending-approval' ? t('approvalPending', { name }) : installed ? t('updateSuccess', { name }) : t('installSuccess', { name }))
      if (data.kind === 'module') router.push(`/admin/modules?module=${encodeURIComponent(data.key)}`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('installFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant={installed ? 'outline' : 'default'} disabled={busy || current || !canInstall} onClick={install}>
      {installed ? <RefreshCw size={14} aria-hidden /> : <Download size={14} aria-hidden />}
      {busy ? t('installing') : current ? t('installed') : installed ? t('update') : t('install')}
    </Button>
  )
}

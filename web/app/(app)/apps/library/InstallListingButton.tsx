'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { safeNextPath } from '../../../../lib/login-return-path'

/**
 * Same-origin review path the marketplace install must return. Reuses
 * safeNextPath so backslash-normalized protocol-relative values such as
 * `/\evil.example` fail closed: WHATWG URL parsing treats `\` as `/` on
 * http(s), so those resolve off-origin. A literal backslash is also
 * refused — the helper would otherwise rewrite `/admin\apps` to
 * `/admin/apps`. The helper's `/` sentinel is a refusal here: a
 * successful install must name a real draft/app path, never home.
 */
export function marketplaceReviewUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const reviewUrl = (data as { reviewUrl?: unknown }).reviewUrl
  if (typeof reviewUrl !== 'string' || reviewUrl.includes('\\')) return null
  const safe = safeNextPath(reviewUrl)
  if (safe === '/' || safe.includes('\\')) return null
  return safe
}

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
      // Status first: a non-JSON 401/403/404/500 must keep the marketplace
      // refusal (or the fallback with the status), never a swallowed parse.
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, t('installFailed')))
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new Error(`${t('installFailed')} (status ${response.status})`)
      }
      const reviewUrl = marketplaceReviewUrl(data)
      if (!reviewUrl) throw new Error(t('installFailed'))
      toast.success(t('draftReady', { name }))
      router.push(reviewUrl as never)
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
      {busy ? t('preparing') : current ? t('installed') : installed ? t('reviewUpdate') : t('reviewInstall')}
    </Button>
  )
}

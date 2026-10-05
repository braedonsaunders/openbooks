'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ApiResponseError, readApiErrorMessage } from '../../../../lib/api-error'
import { waitForShopifyReview } from './shopify-review-poll'
import { WizardLayout } from '../../../../components/page-layout'
import { Badge, Button, Input, Label, PageHeader, SearchSelect } from '@openbooks/ui'
import { Switch } from '@/components/switch'

interface AccountOption {
  value: string
  label: string
}

interface Proposal {
  role: string
  key: string
  accountId: string | null
  accountName: string | null
  confidence: 'high' | 'medium' | 'unmapped'
  note: string
}

interface Review {
  channel: { id: string; name: string; shop: string; status: string; currency: string }
  counts: { queued: number; matched: number; ignored: number }
  via: { bySku: number; byBarcode: number }
  locations: { total: number; mapped: number }
  proposals: Proposal[]
  oauthAvailable: boolean
}

function proposalChoices(proposals: Proposal[]): Record<string, string> {
  const chosen: Record<string, string> = {}
  for (const proposal of proposals) {
    if (proposal.accountId) chosen[`${proposal.role}:${proposal.key}`] = proposal.accountId
  }
  return chosen
}

type Step = 'shop' | 'method' | 'review'

/**
 * Connect Shopify in three steps: name the shop, choose OAuth or a
 * custom-app token, then review matches, locations and posting accounts
 * before anything syncs. The review saves nothing until Start syncing.
 */
export function ShopifyConnectWizard() {
  const t = useTranslations('channels')
  const tc = useTranslations('common.actions')
  const router = useRouter()
  const searchParams = useSearchParams()
  const oauthError = searchParams.get('oauth')
  const resumeChannel = searchParams.get('channel')
  const [step, setStep] = useState<Step>('shop')
  const [shop, setShop] = useState('')
  const [mode, setMode] = useState<'oauth' | 'token'>('oauth')
  const [token, setToken] = useState('')
  const [secret, setSecret] = useState('')
  const [push, setPush] = useState(false)
  const [busy, setBusy] = useState(false)
  const [channelId, setChannelId] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [reviewFailure, setReviewFailure] = useState<string | null>(null)
  const [reviewReload, setReviewReload] = useState(0)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [accountOptions, setAccountOptions] = useState<AccountOption[] | null>(null)

  useEffect(() => {
    if (oauthError) toast.error(oauthError)
  }, [oauthError])

  useEffect(() => {
    let cancelled = false
    fetch('/api/forms/options?source=gl_accounts')
      .then(async (res) => {
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { options: AccountOption[] }
        if (!cancelled) setAccountOptions(body.options)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Resume a connection that stalled before review (OAuth finished in
  // another tab, or the operator left mid-flow): the review endpoint
  // answers for any unaccepted channel, so reopening it here restores
  // the exact pending state instead of starting a second channel.
  useEffect(() => {
    if (!resumeChannel) return
    setChannelId(resumeChannel)
    setStep('review')
  }, [resumeChannel])

  useEffect(() => {
    if (step !== 'review' || !channelId || review) return
    const controller = new AbortController()
    setReviewFailure(null)
    void waitForShopifyReview<Review>(channelId, {
      signal: controller.signal,
      failureMessage: t('toast.loadFailed'),
      timeoutMessage: t('connect.reviewTimedOut'),
    }).then((next) => {
      if (controller.signal.aborted) return
      setReview(next)
      setChosen(proposalChoices(next.proposals))
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof ApiResponseError ? error.message : t('toast.loadFailed')
      setReviewFailure(message)
      toast.error(message)
    })
    return () => controller.abort()
  }, [channelId, step, review, reviewReload, t])

  async function start() {
    setBusy(true)
    try {
      const res = await fetch('/api/channels/shopify/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shop,
          mode,
          accessToken: mode === 'token' ? token : undefined,
          webhookSecret: mode === 'token' ? secret : undefined,
          pushCatalog: push,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return
      }
      const body = (await res.json()) as {
        channelId: string
        mode: 'oauth' | 'token'
        installUrl: string | null
        review?: Review
      }
      setChannelId(body.channelId)
      if (body.mode === 'token' && body.review) {
        setReview(body.review)
        setChosen(proposalChoices(body.review.proposals))
        setStep('review')
        return
      }
      if (body.installUrl) {
        window.open(body.installUrl, '_blank', 'noopener')
        setStep('review')
      }
    } catch {
      toast.error(t('toast.loadFailed'))
    } finally {
      setBusy(false)
    }
  }

  function refreshReview() {
    setReviewFailure(null)
    setReviewReload((value) => value + 1)
  }

  async function accept() {
    if (!channelId) return
    setBusy(true)
    try {
      const accountMaps = Object.entries(chosen)
        .filter(([, accountId]) => accountId !== '')
        .map(([key, accountId]) => {
          const [role, mapKey] = key.split(':')
          return { role: role as string, key: mapKey ?? '', accountId }
        })
      const res = await fetch(`/api/channels/${channelId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountMaps }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return
      }
      router.push(`/channels/${channelId}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <WizardLayout
      header={<PageHeader title={t('connect.title')} back={{ href: '/channels', label: t('actions.backToChannels') }} />}
      steps={[
        { key: 'shop', label: t('connect.stepShop') },
        { key: 'method', label: t('connect.stepMethod') },
        { key: 'review', label: t('connect.stepReview') },
      ]}
      currentStep={step}
      footer={
        step === 'review' && review ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => router.push('/channels')}>
              {tc('cancel')}
            </Button>
            <Button disabled={busy} onClick={accept}>
              {t('actions.startSyncing')}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            {step !== 'shop' ? (
              <Button variant="outline" onClick={() => setStep(step === 'review' ? 'method' : 'shop')}>
                {tc('back')}
              </Button>
            ) : null}
            {step === 'shop' ? (
              <Button disabled={shop.trim() === ''} onClick={() => setStep('method')}>
                {tc('next')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={start}>
                {mode === 'oauth' ? t('connect.openShopify') : t('actions.connect')}
              </Button>
            )}
          </div>
        )
      }
    >
      {step === 'shop' ? (
        <div className="space-y-2">
          <Label htmlFor="shop-domain">{t('connect.shopLabel')}</Label>
          <Input
            id="shop-domain"
            value={shop}
            onChange={(event) => setShop(event.target.value)}
            placeholder="mystore.myshopify.com"
            autoComplete="off"
          />
          <p className="text-sm text-slate-500">{t('connect.shopHint')}</p>
        </div>
      ) : null}
      {step === 'method' ? (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant={mode === 'oauth' ? 'default' : 'outline'} onClick={() => setMode('oauth')}>
              {t('connect.oauthTitle')}
            </Button>
            <Button variant={mode === 'token' ? 'default' : 'outline'} onClick={() => setMode('token')}>
              {t('connect.tokenTitle')}
            </Button>
          </div>
          {mode === 'oauth' ? (
            <p className="text-sm text-slate-500">{t('connect.oauthHint')}</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="shop-token">{t('connect.tokenLabel')}</Label>
                <Input id="shop-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
                <p className="text-sm text-slate-500">{t('connect.tokenHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="shop-secret">{t('connect.secretLabel')}</Label>
                <Input id="shop-secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
                <p className="text-sm text-slate-500">{t('connect.secretHint')}</p>
              </div>
            </div>
          )}
          <label className="flex items-start gap-2">
            <Switch on={push} onToggle={() => setPush((value) => !value)} disabled={busy} label={t('connect.pushLabel')} />
            <span>
              <span className="block text-sm font-medium">{t('connect.pushLabel')}</span>
              <span className="block text-sm text-slate-500">{t('connect.pushHint')}</span>
            </span>
          </label>
        </div>
      ) : null}
      {step === 'review' ? (
        review ? (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-medium">{t('connect.reviewTitle')}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {t('connect.matchedLine', { sku: review.via.bySku, barcode: review.via.byBarcode, queued: review.counts.queued })}
              </p>
              <p className="text-sm text-slate-500">
                {t('connect.locationsLine', { mapped: review.locations.mapped, total: review.locations.total })}
              </p>
            </div>
            <div>
              <h3 className="text-sm font-medium">{t('connect.accountsTitle')}</h3>
              <p className="mb-2 text-sm text-slate-500">{t('connect.accountsHint')}</p>
              <ul className="space-y-2">
                {review.proposals.map((proposal) => {
                  const key = `${proposal.role}:${proposal.key}`
                  return (
                    <li key={key} className="flex flex-wrap items-center gap-2">
                      <span className="w-40 text-sm">{proposal.role}{proposal.key ? ` · ${proposal.key}` : ''}</span>
                      {accountOptions ? (
                        <SearchSelect
                          value={chosen[key] ?? ''}
                          onChange={(value) => setChosen((prev) => ({ ...prev, [key]: value }))}
                          options={accountOptions}
                          clearable
                          ariaLabel={proposal.role}
                        />
                      ) : (
                        <Badge variant="outline">{proposal.accountName ?? t('connect.unmapped')}</Badge>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
            <p className="text-sm text-slate-500">{t('connect.acceptHint')}</p>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {reviewFailure ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{reviewFailure}</p>
              : <p className="text-sm text-slate-500">{t('connect.waitingOAuth')}</p>}
            <Button variant="outline" size="sm" onClick={refreshReview}>
              {tc('refresh')}
            </Button>
          </div>
        )
      ) : null}
    </WizardLayout>
  )
}

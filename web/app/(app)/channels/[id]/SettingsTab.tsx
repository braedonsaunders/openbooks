'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { Button, Input, Label, Switch } from '@openbooks/ui'
import { DisclosureSection } from '@openbooks/ui'

interface ChannelSettings {
  autoImportProducts: boolean
  syncInventory: boolean
  pushCatalog: boolean
  apiVersion: string
  rateLimitBudget: number
}

/**
 * The connector settings section: everyday toggles up front, the API
 * version, rate budget and webhook topics inside Advanced. Saving writes
 * the whole settings object so toggles can never half-apply. Posting
 * accounts live in the Setup sections above; this form only tunes how
 * the connector behaves.
 */
export function SettingsTab({ channelId }: { channelId: string }) {
  const t = useTranslations('channels')
  const tc = useTranslations('common')
  const [settings, setSettings] = useState<ChannelSettings | null>(null)
  const [topics, setTopics] = useState<string[]>([])
  const [isShopify, setIsShopify] = useState(false)
  const [saving, setSaving] = useState(false)

  // Fetch kickoff: every update sits in a promise continuation, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  // Settings stored on the channel are already default-filled by the
  // adapter schema, so the form renders exactly what a save would keep.
  const load = useCallback(() => {
    return fetch(`/api/channels/${channelId}`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res))
          return
        }
        const body = (await res.json()) as {
          channel: { kind: string; settings: ChannelSettings }
          topics: string[]
        }
        setIsShopify(body.channel.kind === 'shopify')
        setSettings(body.channel.settings)
        setTopics(body.topics)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  useEffect(() => {
    void load()
  }, [load])

  async function saveSettings() {
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch(`/api/channels/${channelId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      })
      if (!res.ok) toast.error(await readApiErrorMessage(res))
      else toast.success(tc('save'))
    } finally {
      setSaving(false)
    }
  }

  // Connector-specific tunables: other kinds keep the Setup sections
  // above, so this form stays out of their way entirely.
  if (!settings || !isShopify) return null
  const advancedInvalid =
    !/^\d{4}-\d{2}$/.test(settings.apiVersion) || !Number.isInteger(settings.rateLimitBudget) || settings.rateLimitBudget <= 0
  const webhookUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/api/channels/${channelId}/webhooks`

  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-4">
        <h2 className="text-base font-medium">{t('settings.title')}</h2>
        <label className="flex items-start gap-2">
          <Switch checked={settings.autoImportProducts} onCheckedChange={(value) => setSettings((prev) => (prev ? { ...prev, autoImportProducts: value } : prev))} />
          <span>
            <span className="block text-sm font-medium">{t('settings.autoImport')}</span>
            <span className="block text-sm text-slate-500">{t('settings.autoImportHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <Switch checked={settings.syncInventory} onCheckedChange={(value) => setSettings((prev) => (prev ? { ...prev, syncInventory: value } : prev))} />
          <span>
            <span className="block text-sm font-medium">{t('settings.syncInventory')}</span>
            <span className="block text-sm text-slate-500">{t('settings.syncInventoryHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <Switch checked={settings.pushCatalog} onCheckedChange={(value) => setSettings((prev) => (prev ? { ...prev, pushCatalog: value } : prev))} />
          <span>
            <span className="block text-sm font-medium">{t('settings.push')}</span>
            <span className="block text-sm text-slate-500">{t('settings.pushHint')}</span>
          </span>
        </label>
      </section>
      <DisclosureSection title={t('settings.advanced')} summary={t('settings.advancedSummary')} forceOpen={advancedInvalid}>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="channel-api-version">{t('settings.apiVersion')}</Label>
            <Input id="channel-api-version" value={settings.apiVersion} onChange={(event) => setSettings((prev) => (prev ? { ...prev, apiVersion: event.target.value } : prev))} />
            <p className="text-sm text-slate-500">{t('settings.apiVersionHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-rate-limit">{t('settings.rateLimit')}</Label>
            <Input
              id="channel-rate-limit"
              type="number"
              min={1}
              value={settings.rateLimitBudget}
              onChange={(event) => setSettings((prev) => (prev ? { ...prev, rateLimitBudget: Number(event.target.value) } : prev))}
            />
            <p className="text-sm text-slate-500">{t('settings.rateLimitHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('settings.webhookUrl')}</Label>
            <p className="font-mono text-xs break-all">{webhookUrl}</p>
            <p className="text-sm text-slate-500">{t('settings.webhookUrlHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('settings.topics')}</Label>
            <ul className="flex flex-wrap gap-1">
              {topics.map((topic) => (
                <li key={topic} className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs dark:bg-slate-800">
                  {topic}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </DisclosureSection>
      <div className="flex justify-end">
        <Button disabled={saving} onClick={saveSettings}>
          {t('settings.saveSettings')}
        </Button>
      </div>
    </div>
  )
}

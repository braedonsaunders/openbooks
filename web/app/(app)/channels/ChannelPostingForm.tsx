'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button, DisclosureSection, SearchSelect, TagInput } from '@openbooks/ui'
import { Switch } from '../../../components/switch'
import { useAppAction } from '@/lib/use-app-action'
import { channelRequest } from './channel-client'

interface PolicyView {
  mode: string
  unpaidCreatesSalesOrder: boolean
  guestCustomerPartyId: string | null
  guestCustomerName: string | null
  createPromotionOnMatchMiss: boolean
  cutoffTz: string
  excludedTags: string[]
  excludedSources: string[]
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * Channel Posting: the configure depth for order-to-document rules. Everyday
 * depth is the current effective mode per channel; saving writes a new
 * effective-dated row (posted history never reinterprets); cut-off, excluded
 * tags/sources and the history sit inside the advanced section.
 */
export function ChannelPostingForm({
  canManage,
  today,
  channels,
  policies,
  history,
  customers,
}: {
  canManage: boolean
  today: string
  channels: { id: string; name: string; kind: string; currency: string }[]
  policies: Record<string, PolicyView | null>
  history: Record<string, PolicyView[]>
  customers: { value: string; label: string }[]
}) {
  return (
    <div className="space-y-4">
      {channels.map((channel) => (
        <ChannelPolicyCard
          key={channel.id}
          channel={channel}
          policy={policies[channel.id] ?? null}
          history={history[channel.id] ?? []}
          customers={customers}
          canManage={canManage}
          today={today}
        />
      ))}
    </div>
  )
}

function ChannelPolicyCard({
  channel,
  policy,
  history,
  customers,
  canManage,
  today,
}: {
  channel: { id: string; name: string; kind: string; currency: string }
  policy: PolicyView | null
  history: PolicyView[]
  customers: { value: string; label: string }[]
  canManage: boolean
  today: string
}) {
  const t = useTranslations('channels')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [mode, setMode] = useState(policy?.mode ?? 'per_order')
  const [unpaid, setUnpaid] = useState(policy?.unpaidCreatesSalesOrder ?? false)
  const [guest, setGuest] = useState(policy?.guestCustomerPartyId ?? '')
  const [createPromotion, setCreatePromotion] = useState(policy?.createPromotionOnMatchMiss ?? false)
  const [cutoffTz, setCutoffTz] = useState(policy?.cutoffTz ?? 'UTC')
  const [excludedTags, setExcludedTags] = useState<string[]>(policy?.excludedTags ?? [])
  const [excludedSources, setExcludedSources] = useState<string[]>(policy?.excludedSources ?? [])
  const [effectiveFrom, setEffectiveFrom] = useState(today)

  const onSave = async () => {
    await execute(
      () =>
        channelRequest<{ effectiveFrom: string }>(
          `/api/channels/${channel.id}/posting-policy`,
          {
            method: 'POST',
            body: {
              mode,
              unpaidCreatesSalesOrder: unpaid,
              guestCustomerPartyId: guest === '' ? null : guest,
              createPromotionOnMatchMiss: createPromotion,
              cutoffTz,
              excludedTags,
              excludedSources,
              effectiveFrom,
            },
          },
          t('posting.save'),
        ),
      {
        fallbackMessage: t('posting.save'),
        onOk: (outcome) => {
          router.refresh()
          toast.success(t('posting.saved', { date: outcome.effectiveFrom }))
        },
      },
    )
  }

  return (
    <section className="rounded-lg border p-4" aria-label={channel.name}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {channel.name} <span className="font-normal text-slate-500">· {channel.currency}</span>
        </h3>
        {policy ? (
          <p className="text-xs text-slate-500">
            {t(`posting.${policy.mode === 'daily_summary' ? 'modeDailySummary' : 'modePerOrder'}`)}
          </p>
        ) : (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('posting.noPolicy')}</p>
        )}
      </div>
      <ActionAlert error={refusal} fallbackMessage={t('posting.save')} />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t('posting.mode')}</span>
          <select
            className="w-full rounded-md border px-2 py-1.5"
            value={mode}
            disabled={!canManage || busy}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="per_order">{t('posting.modePerOrder')}</option>
            <option value="daily_summary">{t('posting.modeDailySummary')}</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t('posting.effectiveFrom')}</span>
          <input
            type="date"
            className="w-full rounded-md border px-2 py-1.5"
            value={effectiveFrom}
            min={today}
            disabled={!canManage || busy}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {mode === 'daily_summary' ? t('posting.modeDailySummaryDescription') : t('posting.modePerOrderDescription')}
      </p>
      <div className="mt-3 space-y-3">
        <Switch
          on={unpaid}
          disabled={!canManage || busy}
          label={t('posting.unpaidCreatesSalesOrder')}
          onToggle={() => setUnpaid((flag) => !flag)}
        />
        <Switch
          on={createPromotion}
          disabled={!canManage || busy}
          label={t('posting.createPromotion')}
          onToggle={() => setCreatePromotion((flag) => !flag)}
        />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('posting.guestCustomer')}</span>
          <SearchSelect
            options={customers}
            value={guest}
            onChange={(value) => setGuest(value ?? '')}
            placeholder={t('posting.guestCustomerDescription')}
          />
        </label>
      </div>
      <DisclosureSection title={t('posting.advanced')} summary={t('posting.advancedSummary')}>
        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t('posting.cutoffTz')}</span>
            <input
              className="w-full rounded-md border px-2 py-1.5"
              value={cutoffTz}
              disabled={!canManage || busy}
              onChange={(e) => setCutoffTz(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-3 space-y-3">
          <div>
            <span className="mb-1 block text-sm font-medium">{t('posting.excludedTags')}</span>
            <TagInput
              id={`excluded-tags-${channel.id}`}
              value={excludedTags}
              onChange={setExcludedTags}
              placeholder={t('posting.excludedTags')}
              ariaLabel={t('posting.excludedTags')}
              allowNew
            />
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium">{t('posting.excludedSources')}</span>
            <TagInput
              id={`excluded-sources-${channel.id}`}
              value={excludedSources}
              onChange={setExcludedSources}
              placeholder={t('posting.excludedSources')}
              ariaLabel={t('posting.excludedSources')}
              allowNew
            />
          </div>
        </div>
        {history.length > 0 ? (
          <div className="mt-3">
            <h4 className="text-sm font-medium">{t('posting.history')}</h4>
            <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-300">
              {history.map((row) => (
                <li key={`${row.effectiveFrom}-${row.mode}`}>
                  {row.effectiveFrom}{row.effectiveTo ? ` – ${row.effectiveTo}` : ' – …'} ·{' '}
                  {t(`posting.${row.mode === 'daily_summary' ? 'modeDailySummary' : 'modePerOrder'}`)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DisclosureSection>
      {canManage ? (
        <div className="mt-3">
          <Button disabled={busy} onClick={onSave}>
            {t('posting.save')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

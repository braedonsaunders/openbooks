'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Alert, Button, Input, Label, Select } from '@openbooks/ui'
import { useBusinessToday } from '../../../../../components/business-date-provider'
import { useAppAction } from '../../../../../lib/use-app-action'

interface Fact {
  key: string
  kind: 'choice' | 'integer' | 'decimal' | 'boolean'
  label: string
  legalBasis: string
  refusalReason: string
  required: boolean
  effectivePeriod?: 'date' | 'calendar_year'
  scale?: number
  min?: string
  max?: string
  choices?: { value: string; label: string }[]
}
interface Pack { country: string; facts: Fact[] }
interface Employer { id: string; name: string; country: string | null }
interface Row {
  id: string
  subsidiaryId: string
  country: string
  factKey: string
  effectiveFrom: string
  factValue: string
  changeReason: string
}
interface Payload { packs: Pack[]; rows: Row[]; subsidiaries: Employer[] }

/** Pack-declared employer facts, audited and effective-dated in Payroll Setup. */
export function EmployerFactsSection() {
  const t = useTranslations('payroll.settingsPage.employerFacts')
  const tc = useTranslations('common')
  const today = useBusinessToday()
  const [data, setData] = useState<Payload | null>(null)
  const [country, setCountry] = useState('')
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [factKey, setFactKey] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const { execute: executeLoad, busy: loading } = useAppAction()
  const saveAction = useAppAction()

  const load = useCallback(async () => {
    await executeLoad(() => fetchAction<Payload>('/api/payroll/settings/employer-facts'), {
      fallbackMessage: t('loadFailed'),
      onRefused: (error) => setFailure(error.displayMessage(t('loadFailed'))),
      onOk: (payload) => {
        setData(payload)
        setFailure(null)
      },
    })
  }, [executeLoad, t])

  useEffect(() => { void load() }, [load])

  const selectedCountry = country || data?.packs[0]?.country || ''
  const selectedSubsidiaryId = subsidiaryId || data?.subsidiaries[0]?.id || ''
  const pack = data?.packs.find((candidate) => candidate.country === selectedCountry)
  const fact = pack?.facts.find((candidate) => candidate.key === factKey) ?? pack?.facts[0]
  const entity = data?.subsidiaries.find((candidate) => candidate.id === selectedSubsidiaryId)
  const visibleRows = useMemo(() => data?.rows.filter((row) =>
    row.country === selectedCountry && row.subsidiaryId === selectedSubsidiaryId,
  ) ?? [], [data, selectedCountry, selectedSubsidiaryId])

  const save = async () => {
    if (!fact) return
    await saveAction.execute(() => fetchAction('/api/payroll/settings/employer-facts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry, factKey: fact.key, subsidiaryId: selectedSubsidiaryId, effectiveFrom: fact.effectivePeriod === 'calendar_year' ? `${effectiveFrom.slice(0, 4)}-01-01` : effectiveFrom, value, changeReason: reason }),
      }), {
        fallbackMessage: t('saveFailed'),
        onRefused: (error) => setFailure(error.displayMessage(t('saveFailed'))),
        onOk: () => {
          setFailure(null)
          toast.success(t('saved'))
          setValue('')
          setReason('')
          void load()
        },
      })
  }

  if (!data && !failure && loading) return <p role="status">{t('loading')}</p>

  const entityName = entity?.name ?? t('legalEmployer')
  return (
    <section className="space-y-5" aria-labelledby="employer-facts-heading">
      <div>
        <h2 id="employer-facts-heading" className="text-lg font-semibold">{t('heading')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {failure && <Alert variant="destructive">{failure} <Button variant="outline" onClick={() => void load()} disabled={loading}>{tc('actions.retry')}</Button></Alert>}
      {data && data.packs.length === 0 && <Alert>{t('noPacks')}</Alert>}
      {data && data.packs.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="employer-fact-country">{t('country')}</Label>
              <Select id="employer-fact-country" value={selectedCountry} onChange={(event) => { setCountry(event.target.value); setFactKey(''); setValue('') }}>
                {data.packs.map((entry) => <option key={entry.country} value={entry.country}>{entry.country}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="employer-fact-subsidiary">{t('subsidiary')}</Label>
              <Select id="employer-fact-subsidiary" value={selectedSubsidiaryId} onChange={(event) => setSubsidiaryId(event.target.value)}>
                {data.subsidiaries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.country ? ` · ${entry.country}` : ''}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="employer-fact-name">{t('fact')}</Label>
              <Select id="employer-fact-name" value={fact?.key ?? ''} onChange={(event) => { setFactKey(event.target.value); setValue('') }}>
                {pack?.facts.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </Select>
            </div>
            {fact && <div className="rounded-md border p-3 text-sm"><p>{fact.legalBasis}</p><p className="mt-1 text-muted-foreground">{fact.refusalReason}</p></div>}
            <div className="space-y-1">
              <Label htmlFor="employer-fact-effective">{t('effectiveFrom')}</Label>
              <Input id="employer-fact-effective" type={fact?.effectivePeriod === 'calendar_year' ? 'number' : 'date'} min={fact?.effectivePeriod === 'calendar_year' ? '2000' : undefined} max={fact?.effectivePeriod === 'calendar_year' ? '2100' : undefined} value={fact?.effectivePeriod === 'calendar_year' ? effectiveFrom.slice(0, 4) : effectiveFrom} onChange={(event) => setEffectiveFrom(fact?.effectivePeriod === 'calendar_year' ? `${event.target.value}-01-01` : event.target.value)} />
            </div>
            {fact?.kind === 'choice' ? (
              <div className="space-y-1"><Label htmlFor="employer-fact-value">{fact.label}</Label><Select id="employer-fact-value" value={value} onChange={(event) => setValue(event.target.value)}><option value="">{t('selectPlaceholder')}</option>{fact.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></div>
            ) : fact?.kind === 'boolean' ? (
              <div className="space-y-1"><Label htmlFor="employer-fact-value">{fact.label}</Label><Select id="employer-fact-value" value={value} onChange={(event) => setValue(event.target.value)}><option value="">{t('selectPlaceholder')}</option><option value="true">{t('yes')}</option><option value="false">{t('no')}</option></Select></div>
            ) : (
              <div className="space-y-1"><Label htmlFor="employer-fact-value">{fact?.label}</Label><Input id="employer-fact-value" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder={fact?.kind === 'decimal' ? t('decimalPlaces', { scale: fact.scale ?? 0 }) : t('wholeNumber')} /></div>
            )}
            <div className="space-y-1"><Label htmlFor="employer-fact-reason">{t('reason')}</Label><Input id="employer-fact-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></div>
            <Button onClick={() => void save()} disabled={saveAction.busy || !fact || !value || !reason.trim() || !selectedSubsidiaryId}>{saveAction.busy ? t('saving') : t('save')}</Button>
          </div>
          <div className="space-y-3" aria-label={t('currentFacts', { name: entity?.name ?? t('employerFallback') })}>
            <h3 className="font-medium">{t('currentValues', { name: entityName })}</h3>
            {visibleRows.length === 0 ? <p className="text-sm text-muted-foreground">{t('noRows')}</p> : visibleRows.map((row) => {
              const declaration = pack?.facts.find((entry) => entry.key === row.factKey)
              return <article key={row.id} className="rounded-md border p-3"><h4 className="font-medium">{declaration?.label ?? row.factKey}</h4><p>{row.factValue} · {t('effectiveOn', { date: row.effectiveFrom })}</p><p className="text-sm text-muted-foreground">{row.changeReason}</p></article>
            })}
          </div>
        </div>
      )}
    </section>
  )
}

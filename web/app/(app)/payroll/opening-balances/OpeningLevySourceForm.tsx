'use client'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button, FieldLabel, Input, Select, Skeleton } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { readOpeningLevySourceContext } from '@openbooks/engine/payroll/opening-levy-source-authority'

type Context = Awaited<ReturnType<typeof readOpeningLevySourceContext>>
type Allocation = Context['allocations'][number]
type Draft = { programKey: Allocation['programKey']; region: string; subRegion: string; filingAccountId: string | null; amount: string }
type Props = {
  employeePartyId: string
  year: number
  openingAmounts: Record<string, string>
  canManage: boolean
  annualDirty: boolean
  onSaved: () => void
}

const CA_PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']
const CA_EHT_PROVINCES = ['BC','MB','NL','ON']
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

function initialAllocations(context: Context): Draft[] | null {
  if (context.allocations.length) return context.allocations.map(row => ({ ...row }))
  if (context.record?.country === 'CA') return [
    ...CA_PROVINCES.map(region => ({ programKey: 'ca_wcb' as const, region, subRegion: '', filingAccountId: null, amount: '' })),
    ...CA_EHT_PROVINCES.map(region => ({ programKey: 'ca_eht' as const, region, subRegion: '', filingAccountId: null, amount: '' })),
    { programKey: 'ca_cnt', region: 'QC', subRegion: '', filingAccountId: null, amount: '' },
  ]
  if (context.record?.country !== 'US') return null
  const selectedSui = context.suiAccounts.filter(account => !context.openingSuiStates.includes(account.stateCode))
  for (const id of context.openingSuiAccountIds) {
    const account = context.suiAccounts.find(item => item.id === id)
    if (account && !selectedSui.some(item => item.id === id)) selectedSui.push(account)
  }
  const suiRows = selectedSui.map(account => ({
    programKey: 'us_sui' as const, region: account.stateCode, subRegion: '', filingAccountId: account.id, amount: '',
  }))
  for (const region of context.openingSuiStates) if (!suiRows.some(row => row.region === region)) {
    suiRows.push({ programKey: 'us_sui', region, subRegion: '', filingAccountId: null, amount: '' })
  }
  return [
    ...context.eins.map(ein => ({ programKey: 'us_futa' as const, region: 'US', subRegion: '', filingAccountId: ein.id, amount: '' })),
    ...suiRows,
  ]
}

/** Captures original statutory allocations within the selected employee opening. */
export function OpeningLevySourceForm(props: Props) {
  return <OpeningLevySourceBody key={`${props.employeePartyId}:${props.year}`} {...props} />
}

function OpeningLevySourceBody({ employeePartyId, year, openingAmounts, canManage, annualDirty, onSaved }: Props) {
  const t = useTranslations('payroll.openingBalances.levySource')
  const [reload, setReload] = useState(0)
  const [context, setContext] = useState<Context | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reason, setReason] = useState('')
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = useRef(false)
  const draftOpening = useRef<string | null>(null)
  const mounted = useRef(false)
  const saveController = useRef<AbortController | null>(null)
  const savedCallback = useRef(onSaved)
  savedCallback.current = onSaved
  const loadFailed = t('loadFailed')
  const identityMismatch = t('identityMismatch')

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; saveController.current?.abort() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 15000)
    setLoading(true); setLoadError('')
    void (async () => {
      const params = new URLSearchParams({ employeePartyId, taxYear: String(year) })
      const response = await fetch('/api/payroll/opening-balances/levy-source?' + params, { signal: controller.signal })
      if (!response.ok) throw Error(await readApiErrorMessage(response, loadFailed))
      const next = await response.json() as Context
      if (!active) return
      if (controller.signal.aborted) throw Error(loadFailed)
      if (next.record && (next.record.employeePartyId !== employeePartyId || next.record.taxYear !== year)) throw Error(identityMismatch)
      setContext(next)
      // A refreshed account/source context must never replace unsaved operator entries.
      if (!dirty.current) {
        setDrafts(initialAllocations(next))
        draftOpening.current = next.record ? `${next.record.openingBalanceId}:${next.record.openingSha256}` : null
      }
    })().catch((cause: unknown) => {
      if (active) setLoadError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : loadFailed)
    }).finally(() => { clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [employeePartyId, year, reload, loadFailed, identityMismatch])

  const record = context?.record
  const country = record?.country
  const sourceReady = !!record?.employerAuthorityId && !!record.sourceFileId && !!record.sourceVersionId
    && !!record.sourceSha256 && !!record.sourceReference && !!record.subsidiaryId
  const staleDraft = dirty.current && draftOpening.current !== (record ? `${record.openingBalanceId}:${record.openingSha256}` : null)
  const disabled = !canManage || busy || loading || !!loadError || staleDraft
  const update = (index: number, changes: Partial<Draft>) => {
    dirty.current = true
    setDrafts(rows => rows?.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row) ?? null)
  }
  const addUsRow = (programKey: 'us_sui' | 'us_pa_lst') => {
    dirty.current = true
    setDrafts(rows => [...(rows ?? []), { programKey, region: programKey === 'us_pa_lst' ? 'PA' : '', subRegion: '', filingAccountId: null, amount: '' }])
  }
  const completeDraft = !!drafts?.length && drafts.every(row => row.amount.trim() !== ''
    && row.region.length === 2 && (row.programKey === 'us_futa' ? !!row.filingAccountId
      : row.programKey === 'us_sui' ? !context?.suiAccounts.some(account => account.stateCode === row.region) || !!row.filingAccountId : true)
    && (row.programKey !== 'us_pa_lst' || /^[0-9]{6}$/.test(row.subRegion)))

  async function save() {
    if (!record || !sourceReady || record.levyAuthorityId || !drafts || disabled || annualDirty
      || !completeDraft || !reason.trim() || saveController.current) return
    const controller = new AbortController()
    saveController.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/payroll/opening-balances/levy-source', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          openingBalanceId: record.openingBalanceId,
          expectedOpeningSha256: record.openingSha256,
          allocations: drafts.map(row => ({ ...row, subRegion: row.subRegion || undefined })),
          reason,
        }),
      })
      if (!response.ok) throw Error(await readApiErrorMessage(response, t('saveFailed')))
      if (!mounted.current) return
      if (controller.signal.aborted) throw Error(t('saveFailed'))
      dirty.current = false
      setReload(value => value + 1)
      savedCallback.current()
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : t('saveFailed'))
    } finally {
      clearTimeout(timeout)
      saveController.current = null
      if (mounted.current) setBusy(false)
    }
  }

  return <section className="space-y-4" aria-label={t('title')}>
    <p className="text-sm text-slate-500">{t('help')}</p>
    <Alert><AlertDescription>{t('evidenceLimits')}</AlertDescription></Alert>
    {loading && <Skeleton className="h-24 w-full" />}
    {loadError && <Alert variant="warning"><AlertDescription>{loadError}</AlertDescription></Alert>}
    {!loading && <Button type="button" variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>{t(loadError ? 'retry' : 'reload')}</Button>}
    {!loading && !loadError && context && !record && <p>{t('noOpening')}</p>}
    {record && <dl className="grid gap-2 rounded-lg border border-slate-200 p-3 text-xs sm:grid-cols-2 dark:border-slate-800">
      {([
        ['openingRecord', record.openingBalanceId], ['employee', record.employeePartyId], ['year', String(record.taxYear)],
        ['employer', record.subsidiaryId], ['employerCountry', record.country], ['reference', record.sourceReference],
        ['sourceFile', record.sourceFileId], ['sourceVersion', record.sourceVersionId], ['sourceHash', record.sourceSha256],
        ['openingHash', record.openingSha256], ...(record.allocationSha256 ? [['allocationHash', record.allocationSha256]] : []),
      ] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-slate-500">{t(label as never)}</dt><dd className="break-all">{value ?? t('unavailable')}</dd></div>)}
    </dl>}
    {record && !sourceReady && <Alert variant="warning"><AlertDescription>{t('qualifyEmployerFirst')}</AlertDescription></Alert>}
    {record && sourceReady && country !== 'CA' && country !== 'US' && <Alert variant="warning"><AlertDescription>{t('unsupportedCountry')}</AlertDescription></Alert>}
    {record?.levyAuthorityId && context && <>
      <Alert><AlertDescription>{t('sealed')}</AlertDescription></Alert>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm"><thead><tr className="text-left"><th scope="col" className="p-2">{t('programme')}</th><th scope="col" className="p-2">{t('jurisdiction')}</th><th scope="col" className="p-2">{t('filingAccount')}</th><th scope="col" className="p-2 text-right">{t('amount')}</th></tr></thead>
          <tbody>{context.allocations.map((row, index) => <tr key={index} className="border-t border-slate-100 dark:border-slate-800">
            <td className="p-2">{t(`programmes.${row.programKey}`)}</td><td className="p-2">{row.region}{row.subRegion ? ` · ${row.subRegion}` : ''}</td>
            <td className="p-2">{context.eins.find(ein => ein.id === row.filingAccountId)?.name ?? context.suiAccounts.find(account => account.id === row.filingAccountId)?.name ?? row.filingAccountId ?? '—'}</td><td className="p-2 text-right tabular-nums">{row.amount}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">{t('reasonLabel')}: {record.levyReason}</p>
    </>}
    {record && sourceReady && !record.levyAuthorityId && context && drafts && <>
      {annualDirty && <Alert variant="warning"><AlertDescription>{t('saveFirst')}</AlertDescription></Alert>}
      {staleDraft && <Alert variant="warning"><AlertDescription>{t('staleDraft')}</AlertDescription></Alert>}
      {staleDraft && canManage && <Button type="button" variant="outline" disabled={busy || loading} onClick={() => {
        dirty.current = false; setReason(''); setError(''); setReload(value => value + 1)
      }}>{t('discardAndReload')}</Button>}
      {country === 'CA' && <p className="text-xs text-slate-500">{t('caTotals')}{' '}
        {t('wcbTotal')}: {openingAmounts.wcbAssessableYtd ?? t('unavailable')} · {t('ehtTotal')}: {openingAmounts.ehtRemunerationYtd ?? t('unavailable')}</p>}
      {country === 'US' && <p className="text-xs text-slate-500">{t('usAccounts')}</p>}
      {country === 'US' && !context.eins.length && <Alert variant="warning"><AlertDescription>{t('restoreEin')}</AlertDescription></Alert>}
      <div className="space-y-3">
        {drafts.map((row, index) => {
          const regionOptions = row.programKey === 'ca_wcb' ? CA_PROVINCES : row.programKey === 'ca_eht' ? CA_EHT_PROVINCES
            : row.programKey === 'ca_cnt' ? ['QC'] : row.programKey === 'us_sui' ? US_STATES : row.programKey === 'us_pa_lst' ? ['PA'] : ['US']
          const accountOptions = row.programKey === 'us_futa' ? context.eins
            : row.programKey === 'us_sui' ? context.suiAccounts.filter(account => account.stateCode === row.region) : []
          const showAccount = row.programKey === 'us_futa' || (row.programKey === 'us_sui' && accountOptions.length > 0)
          const fieldId = (field: string) => `levy-source-${index}-${field}`
          return <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-5 dark:border-slate-800">
            <div><FieldLabel htmlFor={fieldId('programme')}>{t('programme')}</FieldLabel><Select id={fieldId('programme')} value={row.programKey} disabled={disabled || country === 'CA'} onChange={event => {
              const programKey = event.target.value as Draft['programKey']
              update(index, { programKey, region: programKey === 'us_pa_lst' ? 'PA' : programKey === 'us_futa' ? 'US' : '', subRegion: '', filingAccountId: null })
            }}>
              {(country === 'CA' ? ['ca_wcb','ca_eht','ca_cnt'] as const : ['us_futa','us_sui','us_pa_lst'] as const).map(key => <option key={key} value={key}>{t(`programmes.${key}`)}</option>)}
            </Select></div>
            <div><FieldLabel htmlFor={fieldId('region')}>{t('jurisdiction')}</FieldLabel><Select id={fieldId('region')} value={row.region} disabled={disabled || country === 'CA' || row.programKey === 'us_futa' || row.programKey === 'us_pa_lst'} onChange={event => {
              update(index, { region: event.target.value, filingAccountId: null })
            }}>
              <option value="">{t('chooseJurisdiction')}</option>{regionOptions.map(code => <option key={code} value={code}>{code}</option>)}
            </Select></div>
            {row.programKey === 'us_pa_lst' && <div><FieldLabel htmlFor={fieldId('psd')}>{t('psd')}</FieldLabel><Input id={fieldId('psd')} value={row.subRegion} maxLength={6} inputMode="numeric" disabled={disabled} onChange={event => update(index, { subRegion: event.target.value })} /></div>}
            <div>{showAccount && <><FieldLabel htmlFor={fieldId('account')}>{t(row.programKey === 'us_futa' ? 'ein' : 'suiAccount')}</FieldLabel><Select id={fieldId('account')} value={row.filingAccountId ?? ''} disabled={disabled} onChange={event => update(index, { filingAccountId: event.target.value || null })}>
              <option value="">{t(row.programKey === 'us_futa' ? 'chooseEin' : 'chooseSuiAccount')}</option>{accountOptions.map(account => <option key={account.id} value={account.id}>{account.name}{!account.isActive ? ` · ${t('inactiveAccount')}` : ''}</option>)}
            </Select></>}<FieldLabel htmlFor={fieldId('amount')} className={showAccount ? 'mt-2' : undefined}>{t('amount')}</FieldLabel><Input id={fieldId('amount')} value={row.amount} inputMode="decimal" disabled={disabled} onChange={event => update(index, { amount: event.target.value })} /></div>
            <div className="flex items-end">{country === 'US' && <Button type="button" variant="outline" disabled={disabled} onClick={() => {
              dirty.current = true; setDrafts(rows => rows?.filter((_, rowIndex) => rowIndex !== index) ?? null)
            }}>{t('remove')}</Button>}</div>
          </div>
        })}
      </div>
      {country === 'US' && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled} onClick={() => addUsRow('us_sui')}>{t('addSui')}</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => addUsRow('us_pa_lst')}>{t('addLst')}</Button></div>}
      <div><FieldLabel htmlFor="levy-source-reason">{t('reasonLabel')}</FieldLabel><Input id="levy-source-reason" value={reason} maxLength={2000} disabled={disabled} onChange={event => { dirty.current = true; setReason(event.target.value) }} /></div>
      {error && <Alert variant="warning"><AlertDescription>{error}</AlertDescription></Alert>}
      {canManage && <Button type="button" onClick={() => void save()} disabled={disabled || annualDirty || !completeDraft || !reason.trim()}>{busy ? t('saving') : t('qualify')}</Button>}
    </>}
  </section>
}

'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, Label, SearchSelect, Select } from '@openbooks/ui'
import { RecordTabs } from '../../../components/module-home/record-tabs'
import { EntityMappingEditor } from './EntityMappingEditor'
import { decodeEntityMappings, type ConnectionEntityMappings } from '@openbooks/engine/src/sync/entity-mapping-contract.ts'
import { readApiErrorMessage } from '../../../lib/api-error'
import { confirmDialog } from '../../../lib/confirm'
import {
  decodeConnectionMappings, resolveSyncSelection, SYNC_CONTENT_KEYS,
  type MappingGroup, type SyncCapabilities,
} from '@openbooks/engine/src/sync/connection-settings.ts'

export function ConnectionSyncContent({ capabilities, value, onChange, attachmentUnavailableReason }: {
  capabilities: SyncCapabilities
  attachmentUnavailableReason?: 'desktopProtocol' | 'notImplemented'
  value: unknown
  onChange: (value: Record<string, boolean>) => void
}) {
  const t = useTranslations('sync.drawer.syncContent')
  const id = useId()
  let selection
  try { selection = resolveSyncSelection(value, capabilities) }
  catch (error) { return <div className="space-y-2"><p role="alert">{error instanceof Error ? error.message : t('invalid')}</p>
    <Button variant="outline" onClick={() => onChange(resolveSyncSelection(undefined, capabilities))}>{t('restoreSupported')}</Button></div> }
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">{t('help')}</p>
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{t('core')}</span><Badge>{t('required')}</Badge></div>
      <p className="mt-1 text-xs text-slate-500">{t('coreHelp')}</p>
    </div>
    {SYNC_CONTENT_KEYS.map((key) => <div key={key} className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center gap-3">
        <input id={`${id}-${key}`} type="checkbox" checked={selection[key]} disabled={!capabilities[key]}
          aria-describedby={`${id}-${key}-help`} onChange={(event) => onChange({ ...selection, [key]: event.target.checked })} />
        <Label htmlFor={`${id}-${key}`} className="flex-1">{t(`labels.${key}`)}</Label>
        {!capabilities[key] ? <Badge>{t('unavailable')}</Badge> : null}
      </div>
      <p id={`${id}-${key}-help`} className="mt-2 text-xs text-slate-500">{t(capabilities[key] ? `hints.${key}` : key === 'attachments' && attachmentUnavailableReason ? `unavailableReasons.${attachmentUnavailableReason}` : 'unavailableHelp')}</p>
    </div>)}
    <p className="text-xs text-slate-500">{t('preservesData')}</p>
  </div>
}

export type MappingDraft = { source: string; target: string; error: string }
export type MappingDrafts = Record<string, MappingDraft>

export function ConnectionMappingWorkspace({ connectionId, groups, value, entityValue, drafts, onDraftChange, onChange, onEntityChange, onPendingChange }: {
  connectionId?: string; groups: readonly MappingGroup[]; value: unknown; entityValue: unknown; drafts: MappingDrafts;
  onDraftChange: (key: string, draft: MappingDraft) => void; onChange: (value: Record<string, unknown>) => void;
  onEntityChange: (value: ConnectionEntityMappings) => void; onPendingChange: (pending: boolean) => void
}) {
  const t = useTranslations('sync.drawer.entityMappings')
  const [selected, setSelected] = useState('entities')
  const model = decodeEntityMappings(entityValue)
  return <div className="space-y-4">
    {model.unavailableRules?.length ? <div role="alert" className="space-y-3 rounded-md border border-amber-300 p-3">
      <p className="text-sm font-medium">{t('unavailableRules')}</p><p className="text-xs text-slate-500">{t('unavailableRulesHelp')}</p>
      {model.unavailableRules.map((rule, index) => <div key={`${rule.key}:${index}`} className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2"><Badge>{rule.key}</Badge><Button size="sm" variant="outline" onClick={() => onEntityChange({ ...model, unavailableRules: model.unavailableRules!.filter((_, position) => position !== index) })}>{t('remove')}</Button></div>
        <SavedMappingValue value={rule.value} emptyLabel={t('emptySavedValue')} /><p className="text-xs text-amber-800 dark:text-amber-200">{rule.reason}</p>
      </div>)}
    </div> : null}
    <RecordTabs label={t('workspace')} active={selected} onChange={setSelected} tabs={[{ key: 'entities', label: t('entityRules') }, { key: 'sourceOptions', label: t('sourceOptions') }]}>
    <div className="pt-4" hidden={selected !== 'entities'}><EntityMappingEditor connectionId={connectionId} value={entityValue} onChange={onEntityChange} onPendingChange={onPendingChange} /></div>
    <div className="pt-4" hidden={selected !== 'sourceOptions'}><ConnectionMappings connectionId={connectionId} groups={groups} value={value} drafts={drafts} onDraftChange={onDraftChange} onChange={onChange} /></div>
  </RecordTabs></div>
}

function SavedMappingValue({ value, emptyLabel }: { value: unknown; emptyLabel: string }) {
  if (value !== null && typeof value === 'object') return <dl className="space-y-1 pl-3 text-sm">{Object.entries(value).map(([key, child]) => <div key={key}><dt className="font-medium">{key}</dt><dd className="pl-3"><SavedMappingValue value={child} emptyLabel={emptyLabel} /></dd></div>)}</dl>
  return <span className="break-all text-sm">{value == null || value === '' ? emptyLabel : String(value)}</span>
}

export function ConnectionMappings({ connectionId, groups, value, onChange, drafts, onDraftChange }: {
  connectionId?: string
  groups: readonly MappingGroup[]
  drafts: MappingDrafts
  onDraftChange: (key: string, draft: MappingDraft) => void
  value: unknown
  onChange: (value: Record<string, unknown>) => void
}) {
  const t = useTranslations('sync.drawer.mappings')
  const id = useId()
  const [selected, setSelected] = useState(groups[0]?.key ?? '')
  const group = groups.find((group) => group.key === selected) ?? groups[0]
  let mappings: Record<string, unknown>
  try { mappings = decodeConnectionMappings(value) }
  catch { return <div className="space-y-2"><p role="alert" className="text-sm text-red-600">{t('unreadable')}</p>
    <Button variant="outline" onClick={async () => { if (await confirmDialog(t('resetConfirm'))) onChange({}) }}>{t('reset')}</Button></div> }
  const update = (key: string, value: unknown, clearChildren = false) => {
    const next = { ...mappings }
    if (value === '' || value == null || (typeof value === 'object' && !Object.keys(value).length)) delete next[key]
    else next[key] = value
    if (clearChildren) for (const field of groups.flatMap((group) => group.fields)) if (field.requires === key) delete next[field.key]
    onChange(next)
  }
  const chooseIdentifier = async (key: string, value: string | null) => {
    if (value === mappings[key]) return
    const children = groups.flatMap((group) => group.fields).filter((field) => field.requires === key && mappings[field.key] != null)
    if (children.length && !await confirmDialog(t('parentChangeConfirm'))) return
    update(key, value, true)
  }
  const known = new Set(groups.flatMap((group) => group.fields.map((field) => field.key)))
  const unknown = Object.keys(mappings).filter((key) => !known.has(key))
  const unsupported = unknown.length ? <div role="alert" className="space-y-2 rounded-md border border-amber-300 p-3">
      <p className="text-sm">{t('unsupported')}</p>
      {unknown.map((key) => <div key={key} className="flex items-center justify-between gap-2"><Badge>{key}</Badge><Button size="sm" variant="outline" onClick={() => update(key, null)}>{t('remove')}</Button></div>)}
    </div> : null
  if (!group) return <div className="space-y-4"><p className="text-sm text-slate-500">{t('automatic')}</p>{unsupported}</div>
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">{t('help')}</p>
    <p className="text-xs text-slate-500">{t('nativeRecords')}</p>
    {!connectionId ? <p role="status" className="text-sm text-slate-500">{t('saveFirst')}</p> : null}
    {unsupported}
    <RecordTabs label={t('areas')} active={group.key} onChange={setSelected}
      tabs={groups.map((group) => ({ key: group.key, label: t(`groups.${group.key}`), count: group.fields.filter((field) => mappings[field.key] != null).length }))}>
      <div className="space-y-4 pt-4">
        <h3 className="text-sm font-semibold">{t(`groups.${group.key}`)}</h3>
        {group.fields.map((field) => {
          const label = t(`fields.${field.key}`)
          if (field.kind !== 'identifier') return <ValueMappings key={field.key} label={label}
            connectionId={connectionId} field={field.key} targets={field.targets ?? []} kind={field.kind} value={mappings[field.key]} onChange={(value) => update(field.key, value)}
            draft={drafts[field.key] ?? { source: '', target: '', error: '' }} onDraftChange={(draft) => onDraftChange(field.key, draft)} />
          const disabled = Boolean(field.requires && !mappings[field.requires])
          return <div key={field.key} className={field.requires ? 'ml-4 border-l border-slate-200 pl-4 dark:border-slate-700' : ''}>
            <Label htmlFor={`${id}-${field.key}`}>{label}</Label>
            <MappingChoice id={`${id}-${field.key}`} label={label} connectionId={connectionId} field={field.key}
              parent={field.requires ? String(mappings[field.requires] ?? '') : undefined}
              disabled={disabled} value={typeof mappings[field.key] === 'string' ? mappings[field.key] as string : ''}
              onChange={(value) => { void chooseIdentifier(field.key, value) }} />
            {mappings[field.key] != null && typeof mappings[field.key] !== 'string' ? <p role="alert" className="mt-1 text-xs text-red-600">{t('invalidValue')}</p> : null}
            {field.requires ? <p className="mt-1 text-xs text-slate-500">{t('childHelp', { parent: t(`fields.${field.requires}`) })}</p> : null}
            {mappings[field.key] != null ? <Button size="sm" variant="ghost" onClick={() => { void chooseIdentifier(field.key, null) }}>{t('useDefault')}</Button> : null}
          </div>
        })}
      </div>
    </RecordTabs>
  </div>
}

function ValueMappings({ connectionId, field, label, targets, kind, value, onChange, draft, onDraftChange }: {
  connectionId?: string; field: string;
  label: string; targets: readonly string[]; kind: 'values' | 'tax'; value: unknown
  onChange: (value: Record<string, unknown> | null) => void
  draft: MappingDraft
  onDraftChange: (draft: MappingDraft) => void
}) {
  const t = useTranslations('sync.drawer.mappings')
  const id = useId()
  const { source, target, error } = draft
  const setSource = (source: string) => onDraftChange({ ...draft, source, error: '' })
  const setTarget = (target: string) => onDraftChange({ ...draft, target, error: '' })
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) return <div className="space-y-2"><h4>{label}</h4><p role="alert">{t('unreadable')}</p>
    <Button size="sm" variant="outline" onClick={() => onChange(null)}>{t('useDefault')}</Button></div>
  const entries = (value ?? {}) as Record<string, unknown>
  const add = () => {
    const normalized = source.trim()
    if (!normalized || !target || Object.keys(entries).some((key) => key.toLowerCase() === normalized.toLowerCase())) { onDraftChange({ ...draft, error: t('valueRequired') }); return }
    onChange({ ...entries, [normalized]: target }); onDraftChange({ source: '', target: '', error: '' })
  }
  return <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
    <h4 className="text-sm font-medium">{label}</h4>
    {Object.entries(entries).map(([source, target]) => <div key={source} className="flex flex-wrap items-center gap-2">
      <Badge>{kind === 'tax' && t.has(`targets.${source}`) ? t(`targets.${source}`) : source}</Badge><span aria-hidden>→</span>
      <Badge>{typeof target !== 'string' ? t('invalidValue') : kind !== 'tax' && t.has(`targets.${target}`) ? t(`targets.${target}`) : target}</Badge>
      <Button size="sm" variant="ghost" aria-label={t('removeValue', { source })} onClick={() => onChange(Object.fromEntries(Object.entries(entries).filter(([key]) => key !== source)))}>{t('remove')}</Button>
    </div>)}
    {!Object.keys(entries).length ? <p className="text-xs text-slate-500">{t('noOverrides')}</p> : null}
    <div className="grid gap-2 sm:grid-cols-2">
      <div><Label htmlFor={`${id}-source`}>{t(kind === 'tax' ? 'taxUse' : 'sourceValue')}</Label>
        {kind === 'tax' ? <Select id={`${id}-source`} value={source} onChange={(event) => setSource(event.target.value)}><option value="">{t('select')}</option>{targets.map((target) => <option key={target} value={target}>{t(`targets.${target}`)}</option>)}</Select>
          : <MappingChoice id={`${id}-source`} label={t('sourceValue')} connectionId={connectionId} field={field} value={source} onChange={setSource} />}</div>
      <div><Label htmlFor={`${id}-target`}>{t(kind === 'tax' ? 'sourceTaxCode' : 'targetValue')}</Label>
        {kind === 'tax' ? <MappingChoice id={`${id}-target`} label={t('sourceTaxCode')} connectionId={connectionId} field={field} value={target} onChange={setTarget} />
          : <Select id={`${id}-target`} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">{t('select')}</option>{targets.map((target) => <option key={target} value={target}>{t(`targets.${target}`)}</option>)}</Select>}</div>
    </div>
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={add}>{t('addValue')}</Button>
      {source || target ? <Button size="sm" variant="ghost" onClick={() => onDraftChange({ source: '', target: '', error: '' })}>{t('discardDraft')}</Button> : null}</div>
  </div>
}

/** Use the same searchable reference control as Setup, without discarding saved choices. */
function MappingChoice({ id, label, connectionId, field, parent, disabled, value, onChange }: {
  id: string; label: string; connectionId?: string; field: string; parent?: string; disabled?: boolean;
  value: string; onChange: (value: string) => void;
}) {
  const t = useTranslations('sync.drawer.mappings')
  const [rows, setRows] = useState<{ value: string; label: string }[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const canLoad = Boolean(connectionId && !disabled)
  useEffect(() => {
    setRows([]); setError(undefined)
    if (!canLoad) { setLoading(false); return }
    const controller = new AbortController()
    const query = new URLSearchParams({ field })
    if (parent) query.set('parent', parent)
    setLoading(true)
    fetch(`/api/platform/connections/${encodeURIComponent(connectionId!)}/mapping-options?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('choicesFailed')))
        const rows: unknown = await response.json()
        if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.value !== 'string' || typeof row.label !== 'string')) throw new Error(t('choicesFailed'))
        if (!controller.signal.aborted) setRows(rows)
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('choicesFailed')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [connectionId, field, parent, canLoad, attempt, t])
  const options = value && !rows.some((row) => row.value === value) ? [{ value, label: t('savedChoice', { value }) }, ...rows] : rows
  return <div className="space-y-1">
    <SearchSelect id={id} ariaLabel={label} value={value} options={options} onChange={onChange}
      disabled={!canLoad} searchable loading={loading} clearable placeholder={t('select')} searchPlaceholder={t('searchChoices')}
      statusMessage={error} statusTone={error ? 'error' : 'muted'} />
    {error ? <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t('retryChoices')}</Button> : null}
  </div>
}

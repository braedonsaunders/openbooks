'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { RecordTabs } from '../../../components/module-home/record-tabs'
import { confirmDialog } from '../../../lib/confirm'
import {
  decodeConnectionMappings, resolveSyncSelection, SYNC_CONTENT_KEYS,
  type MappingGroup, type SyncCapabilities,
} from '@openbooks/engine/src/sync/connection-settings.ts'

export function ConnectionSyncContent({ capabilities, value, onChange }: {
  capabilities: SyncCapabilities
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
      <p id={`${id}-${key}-help`} className="mt-2 text-xs text-slate-500">{t(capabilities[key] ? `hints.${key}` : 'unavailableHelp')}</p>
    </div>)}
    <p className="text-xs text-slate-500">{t('preservesData')}</p>
  </div>
}

export type MappingDraft = { source: string; target: string; error: string }
export type MappingDrafts = Record<string, MappingDraft>

export function ConnectionMappings({ groups, value, onChange, drafts, onDraftChange }: {
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
  const update = (key: string, value: unknown) => {
    const next = { ...mappings }
    if (value === '' || value == null || (typeof value === 'object' && !Object.keys(value).length)) delete next[key]
    else next[key] = value
    onChange(next)
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
    {unsupported}
    <RecordTabs label={t('areas')} active={group.key} onChange={setSelected}
      tabs={groups.map((group) => ({ key: group.key, label: t(`groups.${group.key}`), count: group.fields.filter((field) => mappings[field.key] != null).length }))}>
      <div className="space-y-4 pt-4">
        <h3 className="text-sm font-semibold">{t(`groups.${group.key}`)}</h3>
        {group.fields.map((field) => {
          const label = t(`fields.${field.key}`)
          if (field.kind !== 'identifier') return <ValueMappings key={field.key} label={label}
            targets={field.targets ?? []} kind={field.kind} value={mappings[field.key]} onChange={(value) => update(field.key, value)}
            draft={drafts[field.key] ?? { source: '', target: '', error: '' }} onDraftChange={(draft) => onDraftChange(field.key, draft)} />
          const disabled = Boolean(field.requires && !mappings[field.requires])
          return <div key={field.key} className={field.requires ? 'ml-4 border-l border-slate-200 pl-4 dark:border-slate-700' : ''}>
            <Label htmlFor={`${id}-${field.key}`}>{label}</Label>
            <Input id={`${id}-${field.key}`} value={typeof mappings[field.key] === 'string' ? mappings[field.key] as string : ''}
              disabled={disabled} placeholder={t('sourceIdentifier')} onChange={(event) => update(field.key, event.target.value)} />
            {mappings[field.key] != null && typeof mappings[field.key] !== 'string' ? <p role="alert" className="mt-1 text-xs text-red-600">{t('invalidValue')}</p> : null}
            {field.requires ? <p className="mt-1 text-xs text-slate-500">{t('childHelp', { parent: t(`fields.${field.requires}`) })}</p> : null}
            {mappings[field.key] != null ? <Button size="sm" variant="ghost" onClick={() => update(field.key, null)}>{t('useDefault')}</Button> : null}
          </div>
        })}
      </div>
    </RecordTabs>
  </div>
}

function ValueMappings({ label, targets, kind, value, onChange, draft, onDraftChange }: {
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
          : <Input id={`${id}-source`} value={source} onChange={(event) => setSource(event.target.value)} />}</div>
      <div><Label htmlFor={`${id}-target`}>{t(kind === 'tax' ? 'sourceTaxCode' : 'targetValue')}</Label>
        {kind === 'tax' ? <Input id={`${id}-target`} value={target} onChange={(event) => setTarget(event.target.value)} />
          : <Select id={`${id}-target`} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">{t('select')}</option>{targets.map((target) => <option key={target} value={target}>{t(`targets.${target}`)}</option>)}</Select>}</div>
    </div>
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={add}>{t('addValue')}</Button>
      {source || target ? <Button size="sm" variant="ghost" onClick={() => onDraftChange({ source: '', target: '', error: '' })}>{t('discardDraft')}</Button> : null}</div>
  </div>
}

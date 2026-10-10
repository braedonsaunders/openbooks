'use client'

import { useEffect, useId, useState } from 'react'
import { MultiSelectInput } from '../../../components/custom-field-input'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, Button, FieldHelp, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { decodeEntityMappings, validateEntityMappingCatalog, type ConnectionEntityMappings, type EntityFieldMapping, type EntityMappingField, type EntityMappingMetadata, type MappingScalar } from '@openbooks/engine/src/sync/entity-mapping-contract.ts'

export function EntityMappingEditor({ connectionId, value, onChange, onPendingChange }: {
  connectionId?: string; value: unknown; onChange: (value: ConnectionEntityMappings) => void; onPendingChange: (pending: boolean) => void
}) {
  const t = useTranslations('sync.drawer.entityMappings')
  const id = useId()
  const [entities, setEntities] = useState<EntityMappingMetadata[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<EntityFieldMapping>()
  const [editing, setEditing] = useState<number>()
  const [formError, setFormError] = useState<string>()
  useEffect(() => { onPendingChange(Boolean(draft)); }, [draft, onPendingChange])
  useEffect(() => {
    if (!connectionId) return
    const controller = new AbortController()
    setLoading(true); setError(undefined)
    const query = selected ? `?entity=${encodeURIComponent(selected)}` : ''
    fetch(`/api/platform/connections/${encodeURIComponent(connectionId)}/mapping-catalog${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('metadataFailed')))
        const data = await response.json()
        if (controller.signal.aborted) return
        if (selected) {
          if (!data.entity || !Array.isArray(data.entity.sourceFields) || !Array.isArray(data.entity.nativeFields)) throw new Error(t('metadataFailed'))
          setEntities(entities => entities.map(entity => entity.key === selected ? data.entity : entity))
        } else {
          if (!Array.isArray(data.entities)) throw new Error(t('metadataFailed'))
          setEntities(data.entities);
          const stored = decodeEntityMappings(value);
          setSelected(data.entities.find((entity: EntityMappingMetadata) => stored.entities[entity.key]?.length)?.key ?? data.entities.find((entity: EntityMappingMetadata) => !entity.refusal && entity.nativeFields.length)?.key ?? data.entities[0]?.key ?? '')
        }
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('metadataFailed')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [connectionId, selected, attempt, t])
  let model: ConnectionEntityMappings
  try { model = decodeEntityMappings(value) }
  catch (cause) { return <p role="alert">{cause instanceof Error ? cause.message : t('invalid')}</p> }
  const entity = entities.find(entity => entity.key === selected)
  const rows = model.entities[selected] ?? []
  const target = entity?.nativeFields.find(field => field.key === draft?.target)
  const source = entity?.sourceFields.find(field => field.key === draft?.source)
  const entityLabel = (entity: EntityMappingMetadata) => t.has(`entities.${entity.key}`) ? t(`entities.${entity.key}`) : entity.label
  const fieldLabel = (field: EntityMappingField) => !field.customKey && t.has(`fields.${field.key}`) ? t(`fields.${field.key}`) : field.label
  const changeRows = (rows: EntityFieldMapping[]) => onChange({ ...model, entities: { ...model.entities, [selected]: rows } })
  const discard = () => { setDraft(undefined); setEditing(undefined); setFormError(undefined) }
  const commit = () => {
    if (!entity || !draft) return
    try {
      const next = editing == null ? [...rows, draft] : rows.map((row, index) => index === editing ? draft : row)
      validateEntityMappingCatalog({ version: 1, entities: { [selected]: next } }, [entity])
      changeRows(next); discard()
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : t('invalid')) }
  }
  if (!connectionId) return <p role="status" className="text-sm text-slate-500">{t('saveFirst')}</p>
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">{t('help')}</p>
    <p className="text-xs text-slate-500">{t('protectedFields')} <Link href="/admin/custom-fields" target="_blank" rel="noopener noreferrer" className="text-sky-700 underline">{t('customFields')}</Link></p>
    <div><Label htmlFor={`${id}-entity`}>{t('entity')}</Label>
      <SearchSelect id={`${id}-entity`} value={selected} searchable loading={loading} disabled={Boolean(draft)}
        options={entities.map(entity => ({ value: entity.key, label: entityLabel(entity), group: entity.parent ? t('childEntity') : undefined }))}
        onChange={setSelected} placeholder={t('chooseEntity')} />
    </div>
    {error ? <div role="alert"><p className="text-sm text-red-600">{error}</p><Button variant="outline" onClick={() => setAttempt(attempt => attempt + 1)}>{t('retry')}</Button></div> : null}
    {entity ? <section aria-label={entityLabel(entity)} className="space-y-3">
      <div className="flex items-center justify-between gap-3"><h3 className="font-medium">{entityLabel(entity)}</h3>
        <Button size="sm" variant="outline" disabled={Boolean(draft) || Boolean(entity.refusal) || loading || Boolean(error)} onClick={() => { setDraft({ source: undefined, target: '', missing: 'refuse' }); setEditing(undefined) }}>{t('addField')}</Button>
      </div>
      {entity.refusal ? <p role="status" className="text-sm text-slate-500">{entity.refusal}</p> : !rows.length ? <p className="text-sm text-slate-500">{t('standard')}</p> : null}
      {rows.map((row, index) => <div key={row.target} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
        <Badge>{entity.sourceFields.find(field => field.key === row.source) ? fieldLabel(entity.sourceFields.find(field => field.key === row.source)!) : (row.source || t('defaultOnly'))}</Badge><span aria-hidden>→</span>
        <Badge>{entity.nativeFields.find(field => field.key === row.target) ? fieldLabel(entity.nativeFields.find(field => field.key === row.target)!) : row.target}</Badge>
        {row.values?.length ? <span className="text-xs text-slate-500">{t('valueCount', { count: row.values.length })}</span> : null}
        {row.defaultValue !== undefined ? <span className="text-xs text-slate-500">{t('defaultDisplay', { value: String(row.defaultValue) })}</span> : null}
        <div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" disabled={Boolean(draft)} onClick={() => { setEditing(index); setDraft({ ...row, values: row.values?.map(pair => ({ ...pair })) }); setFormError(undefined) }}>{t('edit')}</Button>
          <Button size="sm" variant="ghost" disabled={Boolean(draft)} onClick={() => changeRows(rows.filter((_, position) => position !== index))}>{t('remove')}</Button></div>
      </div>)}
      {draft ? <fieldset className="space-y-4 rounded-md border border-sky-300 p-4">
        <legend className="px-1 text-sm font-medium">{t(editing == null ? 'newRule' : 'editRule', { entity: entityLabel(entity) })}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor={`${id}-source`}>{t('sourceField')} <FieldHelp help={t('sourceHelp')} /></Label>
            <SearchSelect id={`${id}-source`} value={draft.source ?? ''} clearable searchable placeholder={t('defaultOnly')}
              options={entity.sourceFields.map(field => ({ value: field.key, label: fieldLabel(field) }))}
              onChange={source => setDraft({ ...draft, source: source || undefined, values: undefined })} /></div>
          <div><Label htmlFor={`${id}-target`}>{t('nativeField')} <FieldHelp help={t('targetHelp')} /></Label>
            <SearchSelect id={`${id}-target`} value={draft.target} searchable placeholder={t('chooseField')}
              options={entity.nativeFields.map(field => ({ value: field.key, label: fieldLabel(field), hint: field.help }))}
              onChange={target => setDraft({ ...draft, target, values: undefined, defaultValue: undefined })} /></div>
        </div>
        <div><Label htmlFor={`${id}-missing`}>{t('missing')} <FieldHelp help={t('missingHelp')} /></Label>
          <Select id={`${id}-missing`} value={draft.missing} onChange={event => setDraft({ ...draft, missing: event.target.value as EntityFieldMapping['missing'] })}>
            <option value="refuse">{t('refuse')}</option><option value="keep">{t('keep')}</option><option value="default">{t('useDefault')}</option>
          </Select></div>
        {target ? <div><Label htmlFor={`${id}-default`}>{t('defaultValue')}</Label>
          <MappingValueControl id={`${id}-default`} field={target} value={draft.defaultValue} connectionId={connectionId} entity={selected}
            onChange={defaultValue => setDraft({ ...draft, defaultValue })} />
          <p className="mt-1 text-xs text-slate-500">{t('defaultHelp')}</p></div> : null}
        {source && target ? <div className="space-y-3">
          <Label>{t('values')} <FieldHelp help={t('valuesHelp')} /></Label>
          {(draft.values ?? []).map((pair, index) => <div key={index} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
            <div><Label htmlFor={`${id}-value-source-${index}`}>{t('sourceValue')}</Label><MappingValueControl sourceValue id={`${id}-value-source-${index}`} field={source} value={pair.source} connectionId={connectionId} entity={selected}
              onChange={value => setDraft({ ...draft, values: draft.values!.map((pair, position) => position === index ? { ...pair, source: value ?? '' } : pair) })} /></div>
            <div><Label htmlFor={`${id}-value-target-${index}`}>{t('nativeValue')}</Label><MappingValueControl id={`${id}-value-target-${index}`} field={target} value={pair.target} connectionId={connectionId} entity={selected}
              onChange={value => setDraft({ ...draft, values: draft.values!.map((pair, position) => position === index ? { ...pair, target: value ?? '' } : pair) })} /></div>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, values: draft.values!.filter((_, position) => position !== index) })}>{t('remove')}</Button>
          </div>)}
          <Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, values: [...(draft.values ?? []), { source: '', target: '' }] })}>{t('addValue')}</Button>
        </div> : null}
        {formError ? <p role="alert" className="text-sm text-red-600">{formError}</p> : null}
        <div className="flex gap-2"><Button size="sm" onClick={commit}>{t('apply')}</Button><Button size="sm" variant="outline" onClick={discard}>{t('discard')}</Button></div>
      </fieldset> : null}
    </section> : null}
  </div>
}

/** The same typed text, choice, date and reference controls used by native Setup forms. */
function MappingValueControl({ id, field, value, onChange, connectionId, entity, sourceValue = false }: {
  id: string; field: EntityMappingField; value: MappingScalar | undefined; onChange: (value: MappingScalar | undefined) => void; connectionId: string; entity: string; sourceValue?: boolean
}) {
  const t = useTranslations('sync.drawer.entityMappings')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [search, setSearch] = useState('')
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setOptions([]); setError(undefined)
    if (field.kind !== 'reference') return
    const controller = new AbortController()
    setReferenceLoading(true)
    const query = new URLSearchParams({ entity, [sourceValue ? 'sourceField' : 'target']: field.key, q: search, selected: String(value ?? '') })
    fetch(`/api/platform/connections/${encodeURIComponent(connectionId)}/mapping-catalog?${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('metadataFailed')))
        const data = await response.json()
        if (!Array.isArray(data.options)) throw new Error(t('metadataFailed'))
        if (!controller.signal.aborted) setOptions(data.options)
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('metadataFailed')) })
      .finally(() => { if (!controller.signal.aborted) setReferenceLoading(false) })
    return () => controller.abort()
  }, [connectionId, entity, field.key, field.kind, sourceValue, attempt, search, value, t])
  if (field.kind === 'multi-choice') return <MultiSelectInput id={id} label={field.label} options={(field.options ?? []).map(option => option.value)} value={Array.isArray(value) ? value : []} onChange={onChange} />
  if (field.kind === 'reference') return <div><SearchSelect id={id} value={String(value ?? '')} clearable searchable remote onSearchChange={setSearch} loading={referenceLoading} options={options} onChange={value => onChange(value || undefined)} placeholder={t('chooseRecord')} statusMessage={error} statusTone="error" />
    {error ? <Button variant="outline" onClick={() => setAttempt(attempt => attempt + 1)}>{t('retry')}</Button> : null}</div>
  if (field.kind === 'choice' || field.kind === 'boolean') return <Select id={id} value={String(value ?? '')} onChange={event => onChange(event.target.value === '' ? undefined : field.kind === 'boolean' ? event.target.value === 'true' : event.target.value)}>
    <option value="">{t('none')}</option>{(field.kind === 'boolean' ? [{ value: 'true', label: t('yes') }, { value: 'false', label: t('no') }] : field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </Select>
  return <Input id={id} type={field.kind === 'date' ? 'date' : 'text'} inputMode={field.kind === 'decimal' ? 'decimal' : undefined} value={String(value ?? '')} onChange={event => onChange(event.target.value || undefined)} />
}

'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, DisclosureSection, Input, Label } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '@/components/line-grid'
import { apiJson } from '@/lib/api-error'
import { FamilyOptionsEditor, type EditableOption } from './families/FamilyOptionsEditor'

type FlowStep = 'details' | 'options' | 'preview'

interface PreviewRow extends Record<string, unknown> {
  key: string
  code: string
  price: string
  barcode: string
}

function optionKey(name: string): string {
  return `option:${name}`
}

/** Preview-only code suggestion: the server renders authoritatively on create. */
function slugify(value: string): string {
  const slug = value.trim().toUpperCase().replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug
}

function previewCode(pattern: string, familyCode: string, valuesInOrder: string[]): string {
  const slugs = valuesInOrder.map(slugify)
  return pattern
    .replaceAll('{family}', familyCode.trim())
    .replaceAll('{values}', slugs.join('-'))
    .replaceAll(/\{value(\d+)\}/g, (_, position: string) => slugs[Number(position) - 1] ?? '')
}

function validOptions(options: EditableOption[]): { name: string; values: string[] }[] {
  return options
    .map((option) => ({ name: option.name.trim(), values: option.values.map((value) => value.trim()).filter((value) => value !== '') }))
    .filter((option) => option.name !== '' && option.values.length > 0)
}

function combinations(options: { name: string; values: string[] }[]): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}]
  for (const option of options) {
    const next: Record<string, string>[] = []
    for (const base of combos) {
      for (const value of option.values) next.push({ ...base, [option.name]: value })
    }
    combos = next
  }
  return combos
}

function combinationKey(values: Record<string, string>, names: string[]): string {
  return names.map((name) => `${name}=${values[name] ?? ''}`).join('|')
}

/**
 * Create an item with variants without leaving the item drawer: details,
 * then options with a live variant count, then a preview grid where codes,
 * prices and barcodes stay editable and combinations can be unticked. Create
 * posts one request that the engine fulfils in a single transaction.
 */
export function ItemFamilyCreateFlow({
  kind,
  canManage,
  onBack,
  onCreated,
}: {
  kind: string
  canManage: boolean
  onBack: () => void
  onCreated: (familyId: string) => void
}) {
  const t = useTranslations('items.familyCreate')
  const tCommon = useTranslations('common')
  const [step, setStep] = useState<FlowStep>('details')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [category, setCategory] = useState('')
  const [unit, setUnit] = useState('')
  const [defaultRate, setDefaultRate] = useState('')
  const [options, setOptions] = useState<EditableOption[]>([{ id: null, name: '', values: [] }])
  const [codePattern, setCodePattern] = useState('{family}-{values}')
  const [edits, setEdits] = useState<Record<string, { code?: string; price?: string; barcode?: string }>>({})
  const [included, setIncluded] = useState<ReadonlySet<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usable = useMemo(() => validOptions(options), [options])
  const names = useMemo(() => usable.map((option) => option.name), [usable])
  const combos = useMemo(() => (usable.length > 0 ? combinations(usable) : []), [usable])
  const keys = useMemo(() => combos.map((combo) => combinationKey(combo, names)), [combos, names])
  const includedKeys = useMemo(() => included ?? new Set(keys), [included, keys])

  const rows: PreviewRow[] = useMemo(
    () =>
      combos.map((combo, index) => {
        const key = keys[index]!
        const valuesInOrder = names.map((optionName) => combo[optionName]!)
        const edit = edits[key]
        return {
          key,
          ...Object.fromEntries(names.map((optionName) => [optionKey(optionName), combo[optionName]])),
          code: edit?.code ?? previewCode(codePattern || '{family}-{values}', code, valuesInOrder),
          price: edit?.price ?? '',
          barcode: edit?.barcode ?? '',
        }
      }),
    [combos, keys, names, edits, codePattern, code],
  )

  const columns: LineGridColumn<PreviewRow>[] = useMemo(
    () => [
      ...names.map((optionName) => ({
        key: optionKey(optionName),
        label: optionName,
        width: 'minmax(90px,1fr)',
        type: 'readonly' as const,
      })),
      { key: 'code', label: t('previewCode'), width: 'minmax(140px,1.3fr)', type: 'text' as const },
      { key: 'price', label: t('previewPrice'), width: '110px', type: 'amount' as const },
      { key: 'barcode', label: t('previewBarcode'), width: '140px', type: 'text' as const },
    ],
    [names, t],
  )

  function setRowEdit(key: string, patch: { code?: string; price?: string; barcode?: string }) {
    setEdits((current) => ({ ...current, [key]: { ...current[key], ...patch } }))
  }

  const detailsValid = name.trim() !== ''
  const optionsValid = usable.length > 0
  const previewValid = keys.some((key) => includedKeys.has(key))

  async function create(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const chosen = combos
        .map((combo, index) => ({ combo, key: keys[index]! }))
        .filter(({ key }) => includedKeys.has(key))
        .map(({ combo, key }) => {
          const edit = edits[key]
          const editedCode = (edit?.code ?? '').trim()
          const suggested = previewCode(codePattern || '{family}-{values}', code, names.map((optionName) => combo[optionName]!))
          return {
            optionValues: combo,
            ...(editedCode && editedCode !== suggested ? { code: editedCode } : {}),
            ...((edit?.price ?? '').trim() !== '' ? { price: (edit?.price ?? '').trim() } : {}),
            ...((edit?.barcode ?? '').trim() !== '' ? { barcode: { value: (edit?.barcode ?? '').trim(), kind: 'gtin' as const } } : {}),
          }
        })
      const created = await apiJson<{ family: { id: string } }>(`/api/item-families/with-variants`, {
        method: 'POST',
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          category: category.trim() === '' ? null : category.trim(),
          kind,
          defaultUnit: unit.trim() === '' ? null : unit.trim(),
          defaultRate: defaultRate.trim() === '' ? null : defaultRate.trim(),
          codePattern: codePattern.trim() === '' ? null : codePattern.trim(),
          options: usable.map((option) => ({ name: option.name, values: option.values })),
          variants: chosen,
        }),
      })
      onCreated(created.family.id)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {step === 'details' ? (
        <section className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('detailsTitle')}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('detailsDescription')}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1"><Label>{tCommon('labels.name')} *</Label><Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage || busy} /></div>
            <div className="space-y-1"><Label>{t('familyCode')}</Label><Input value={code} onChange={(event) => setCode(event.target.value)} disabled={!canManage || busy} className="font-mono" /></div>
            <div className="space-y-1"><Label>{t('category')}</Label><Input value={category} onChange={(event) => setCategory(event.target.value)} disabled={!canManage || busy} /></div>
            <div className="space-y-1"><Label>{t('unit')}</Label><Input value={unit} onChange={(event) => setUnit(event.target.value)} disabled={!canManage || busy} /></div>
            <div className="space-y-1"><Label>{t('basePrice')}</Label><Input value={defaultRate} onChange={(event) => setDefaultRate(event.target.value)} disabled={!canManage || busy} inputMode="decimal" className="text-right tabular-nums" /></div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('basePriceHint')}</p>
        </section>
      ) : null}

      {step === 'options' ? (
        <section className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('optionsTitle')}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('optionsDescription')}</p>
            <p className="mt-1 text-sm font-medium text-teal-700 dark:text-teal-300">{t('variantCount', { count: combos.length })}</p>
          </div>
          <FamilyOptionsEditor
            // The parent options state outlives the step: remounting with a
            // fresh empty draft would discard what Back was meant to keep.
            initial={options}
            variantValues={{}}
            onSave={async () => {}}
            onOptionsChange={setOptions}
            hideSave
          />
        </section>
      ) : null}

      {step === 'preview' ? (
        <section className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('previewTitle')}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('previewDescription')}</p>
          </div>
          <LineGrid
            columns={columns}
            rows={rows}
            onRowsChange={(next) => {
              for (const row of next) {
                const previous = rows.find((candidate) => candidate.key === row.key)
                if (!previous) continue
                if (row.code !== previous.code) setRowEdit(String(row.key), { code: String(row.code ?? '') })
                if (row.price !== previous.price) setRowEdit(String(row.key), { price: String(row.price ?? '') })
                if (row.barcode !== previous.barcode) setRowEdit(String(row.key), { barcode: String(row.barcode ?? '') })
              }
            }}
            emptyRow={() => ({ key: '', code: '', price: '', barcode: '' })}
            minRows={0}
            fixedRows
            getRowKey={(row) => String(row.key)}
            selection={canManage ? { selected: new Set(keys.filter((key) => includedKeys.has(key))), onChange: (next) => setIncluded(next) } : undefined}
          />
          <DisclosureSection title={t('advancedTitle')} summary={t('advancedSummary', { pattern: codePattern || '{family}-{values}' })}>
            <div className="space-y-1">
              <Label>{t('codePattern')}</Label>
              <Input value={codePattern} onChange={(event) => setCodePattern(event.target.value)} disabled={!canManage || busy} className="font-mono" />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('codePatternHint')}</p>
            </div>
          </DisclosureSection>
        </section>
      ) : null}

      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <div className="flex gap-2">
        {step === 'details' ? <Button variant="outline" disabled={busy} onClick={onBack}>{tCommon('actions.back')}</Button> : null}
        {step === 'options' ? <Button variant="outline" disabled={busy} onClick={() => setStep('details')}>{tCommon('actions.back')}</Button> : null}
        {step === 'preview' ? <Button variant="outline" disabled={busy} onClick={() => setStep('options')}>{tCommon('actions.back')}</Button> : null}
        {step === 'details' ? <Button disabled={busy || !canManage || !detailsValid} onClick={() => setStep('options')}>{t('continue')}</Button> : null}
        {step === 'options' ? <Button disabled={busy || !canManage || !optionsValid} onClick={() => { setIncluded(null); setStep('preview') }}>{t('reviewVariants')}</Button> : null}
        {step === 'preview' ? <Button disabled={busy || !canManage || !previewValid} onClick={() => void create()}>{busy ? t('creating') : t('create', { count: keys.filter((key) => includedKeys.has(key)).length })}</Button> : null}
      </div>
    </div>
  )
}

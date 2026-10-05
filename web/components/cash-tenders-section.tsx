'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, FieldLabel, Input, SearchSelect, Select } from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { add } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal, compareDecimal, isZeroDecimal } from '@/lib/exact-decimal'

export interface TenderDraft {
  kind: string
  accountId: string
  amount: string
  reference?: string
}

export interface TenderAccountOption {
  value: string
  label: string
}

const KIND_VALUES = ['cash', 'card', 'bank'] as const

export function parseTenderDrafts(raw: unknown): TenderDraft[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      kind: typeof entry.kind === 'string' ? entry.kind : 'cash',
      accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
      amount: typeof entry.amount === 'string' ? entry.amount : '',
      ...(typeof entry.reference === 'string' && entry.reference.length > 0 ? { reference: entry.reference } : {}),
    }))
}

/**
 * Paid-at-sale settlement editor. Tenders name the clearing or bank account
 * each part of the total settled into; the section cross-foots tendered
 * against the document total live, so an undertendered sale is visible
 * before Save — and the kernel refuses it by name at posting regardless.
 * Read-only once posted: the journal owns history from there.
 */
export function CashTendersSection({
  value,
  onChange,
  editable,
  total,
  currency,
  accountOptions,
  defaultAccountId,
}: {
  value: unknown
  onChange: (next: TenderDraft[]) => void
  editable: boolean
  total: string
  currency: string
  accountOptions: TenderAccountOption[]
  defaultAccountId?: string | null
}) {
  const t = useTranslations('ar')
  const { money } = useMoney()
  const tenders = useMemo(() => parseTenderDrafts(value), [value])
  const kindOptions = KIND_VALUES.map((kind) => ({ value: kind, label: t(`tenders.kinds.${kind}`) }))

  // Exact decimal-string cross-foot: entries that are not valid decimals are
  // skipped here and refused by name on save, never coerced or rounded.
  const tendered = useMemo(() => {
    let sum = '0'
    for (const tender of tenders) {
      if (typeof tender.amount !== 'string') continue
      const exact = canonicalDecimal(tender.amount, 4)
      if (exact === null) continue
      sum = add(sum, exact)
    }
    return sum
  }, [tenders])

  const comparison = useMemo(() => {
    try {
      return compareDecimal(tendered, total || '0')
    } catch {
      return 0
    }
  }, [tendered, total])

  const update = (index: number, patch: Partial<TenderDraft>) => {
    onChange(tenders.map((tender, i) => (i === index ? { ...tender, ...patch } : tender)))
  }
  const addTender = () => {
    onChange([...tenders, { kind: 'cash', accountId: defaultAccountId ?? '', amount: '' }])
  }
  const remove = (index: number) => {
    onChange(tenders.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FieldLabel fieldName={t('tenders.title')}>{t('tenders.title')}</FieldLabel>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {t('tenders.tenderedOf', { tendered: money(tendered, { currency }), total: money(total || '0', { currency }) })}
        </span>
        {tenders.length > 0 ? (
          <Badge variant={comparison === 0 ? 'success' : 'warning'}>
            {comparison === 0 ? t('tenders.balanced') : t('tenders.unbalanced')}
          </Badge>
        ) : null}
      </div>
      {editable ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('tenders.help')}</p> : null}
      {tenders.map((tender, index) => (
        <div key={index} className="grid grid-cols-[110px_1fr_130px_1fr_auto] items-end gap-2">
          <div>
            <FieldLabel fieldName={t('tenders.method')}>{t('tenders.method')}</FieldLabel>
            {editable ? (
              <Select value={tender.kind} onChange={(e) => update(index, { kind: e.target.value })}>
                {kindOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            ) : (
              <p className="text-sm">{kindOptions.find((o) => o.value === tender.kind)?.label ?? tender.kind}</p>
            )}
          </div>
          <div>
            <FieldLabel fieldName={t('tenders.account')}>{t('tenders.account')}</FieldLabel>
            {editable ? (
              <SearchSelect
                options={accountOptions}
                value={tender.accountId}
                onChange={(v) => update(index, { accountId: v ?? '' })}
                placeholder={t('tenders.accountPlaceholder')}
              />
            ) : (
              <p className="text-sm">{accountOptions.find((o) => o.value === tender.accountId)?.label ?? tender.accountId}</p>
            )}
          </div>
          <div>
            <FieldLabel fieldName={t('tenders.amount')}>{t('tenders.amount')}</FieldLabel>
            {editable ? (
              <Input
                inputMode="decimal"
                value={tender.amount}
                onChange={(e) => update(index, { amount: e.target.value })}
                placeholder="0.00"
              />
            ) : (
              <p className="text-sm tabular-nums">{money(tender.amount || '0', { currency })}</p>
            )}
          </div>
          <div>
            <FieldLabel fieldName={t('tenders.reference')}>{t('tenders.reference')}</FieldLabel>
            {editable ? (
              <Input
                value={tender.reference ?? ''}
                onChange={(e) => update(index, { reference: e.target.value })}
                placeholder={t('tenders.referencePlaceholder')}
              />
            ) : (
              <p className="text-sm">{tender.reference ?? '—'}</p>
            )}
          </div>
          {editable ? (
            <Button type="button" variant="outline" size="sm" onClick={() => remove(index)}>
              {t('tenders.remove')}
            </Button>
          ) : null}
        </div>
      ))}
      {editable ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={addTender}>
            {t('tenders.add')}
          </Button>
          {tenders.length === 0 && !isZeroDecimal(total || '0') ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('tenders.emptyHint')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

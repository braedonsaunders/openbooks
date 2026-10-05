'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, FieldLabel, Input, SearchSelect, Select } from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { add } from '@openbooks/engine/money'
import { CASH_TENDER_KINDS } from '@openbooks/engine/sales/cash-tenders'
import { canonicalDecimal, compareDecimal, isZeroDecimal } from '@/lib/exact-decimal'

export interface TenderDraft {
  kind: string
  methodLabel?: string
  accountId: string
  storedValueAccountId?: string
  /** Last four of the resolved code, display only — never saved. */
  svLast4?: string
  /** Resolved balance in document currency, display only — never saved. */
  svBalance?: string
  amount: string
  reference?: string
  externalRef?: string
}

export interface TenderAccountOption {
  value: string
  label: string
}

export interface StoredValueResolution {
  accountId: string
  balance: string
  currency: string
  last4: string
  status: string
}

const GATEWAY_LIKE_KINDS = ['bank_transfer', 'wallet', 'gateway'] as const

function pickString(entry: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

export function parseTenderDrafts(raw: unknown): TenderDraft[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      kind: pickString(entry, 'kind') || 'cash',
      ...(pickString(entry, 'methodLabel', 'method_label') ? { methodLabel: pickString(entry, 'methodLabel', 'method_label') } : {}),
      accountId: pickString(entry, 'accountId', 'account_id'),
      ...(pickString(entry, 'storedValueAccountId', 'stored_value_account_id')
        ? { storedValueAccountId: pickString(entry, 'storedValueAccountId', 'stored_value_account_id') }
        : {}),
      ...(pickString(entry, 'svLast4') ? { svLast4: pickString(entry, 'svLast4') } : {}),
      ...(pickString(entry, 'svBalance') ? { svBalance: pickString(entry, 'svBalance') } : {}),
      amount: pickString(entry, 'amount'),
      ...(pickString(entry, 'reference') ? { reference: pickString(entry, 'reference') } : {}),
      ...(pickString(entry, 'externalRef', 'external_ref') ? { externalRef: pickString(entry, 'externalRef', 'external_ref') } : {}),
    }))
}

/**
 * Paid-at-sale settlement editor. Tenders name how each part of the total
 * settled: a clearing or bank account, or a gift card / store credit
 * resolved by code with its live balance shown before Save. The section
 * cross-foots tendered against the document total live, so an undertendered
 * sale is visible before Save — and the kernel refuses it by name at
 * posting regardless. Read-only once posted: the journal owns history
 * from there.
 */
export function CashTendersSection({
  value,
  onChange,
  editable,
  total,
  currency,
  accountOptions,
  defaultAccountId,
  storedValueEnabled,
  resolveStoredValueCode,
}: {
  value: unknown
  onChange: (next: TenderDraft[]) => void
  editable: boolean
  total: string
  currency: string
  accountOptions: TenderAccountOption[]
  defaultAccountId?: string | null
  storedValueEnabled?: boolean
  resolveStoredValueCode?: (code: string) => Promise<StoredValueResolution | null>
}) {
  const t = useTranslations('ar')
  const { money } = useMoney()
  const tenders = useMemo(() => parseTenderDrafts(value), [value])
  const visibleKinds = useMemo(
    () => (CASH_TENDER_KINDS as readonly string[]).filter((kind) => kind !== 'stored_value' || storedValueEnabled),
    [storedValueEnabled],
  )
  const kindOptions = visibleKinds.map((kind) => ({ value: kind, label: t(`tenders.kinds.${kind}`) }))
  const [codeInputs, setCodeInputs] = useState<Record<number, string>>({})
  const [codeErrors, setCodeErrors] = useState<Record<number, string>>({})
  const [checking, setChecking] = useState<Record<number, boolean>>({})

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
  const checkCode = async (index: number) => {
    const code = (codeInputs[index] ?? '').trim()
    if (!code || !resolveStoredValueCode) return
    setChecking((c) => ({ ...c, [index]: true }))
    setCodeErrors((c) => ({ ...c, [index]: '' }))
    try {
      const resolved = await resolveStoredValueCode(code)
      if (!resolved) {
        setCodeErrors((c) => ({ ...c, [index]: t('tenders.codeNotFound') }))
        return
      }
      update(index, {
        storedValueAccountId: resolved.accountId,
        svLast4: resolved.last4,
        svBalance: resolved.balance,
      })
    } finally {
      setChecking((c) => ({ ...c, [index]: false }))
    }
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
      {tenders.map((tender, index) => {
        const isStoredValue = tender.kind === 'stored_value'
        return (
          <div key={index} className="grid grid-cols-[110px_1fr_1fr_130px_1fr_auto] items-end gap-2">
            <div>
              <FieldLabel fieldName={t('tenders.method')}>{t('tenders.method')}</FieldLabel>
              {editable ? (
                <Select
                  value={tender.kind}
                  onChange={(e) => update(index, {
                    kind: e.target.value,
                    ...(e.target.value === 'stored_value'
                      ? { accountId: '' }
                      : { storedValueAccountId: undefined, svLast4: undefined, svBalance: undefined }),
                  })}
                >
                  {kindOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{kindOptions.find((o) => o.value === tender.kind)?.label ?? tender.kind}</p>
              )}
            </div>
            <div>
              <FieldLabel fieldName={t('tenders.label')}>{t('tenders.label')}</FieldLabel>
              {editable ? (
                <Input
                  value={tender.methodLabel ?? ''}
                  onChange={(e) => update(index, { methodLabel: e.target.value })}
                  placeholder={kindOptions.find((o) => o.value === tender.kind)?.label ?? tender.kind}
                />
              ) : (
                <p className="text-sm">{tender.methodLabel || kindOptions.find((o) => o.value === tender.kind)?.label || tender.kind}</p>
              )}
            </div>
            <div>
              <FieldLabel fieldName={isStoredValue ? t('tenders.code') : t('tenders.account')}>
                {isStoredValue ? t('tenders.code') : t('tenders.account')}
              </FieldLabel>
              {isStoredValue ? (
                editable ? (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      <Input
                        value={tender.storedValueAccountId ? `…${tender.svLast4 ?? ''}` : (codeInputs[index] ?? '')}
                        onChange={(e) => {
                          setCodeInputs((c) => ({ ...c, [index]: e.target.value }))
                          if (tender.storedValueAccountId) {
                            update(index, { storedValueAccountId: undefined, svLast4: undefined, svBalance: undefined })
                          }
                        }}
                        placeholder={t('tenders.codePlaceholder')}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={checking[index] || !(codeInputs[index] ?? '').trim()}
                        onClick={() => void checkCode(index)}
                      >
                        {t('tenders.checkBalance')}
                      </Button>
                    </div>
                    {tender.svBalance ? (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {t('tenders.balance', { balance: money(tender.svBalance, { currency }) })}
                      </p>
                    ) : null}
                    {codeErrors[index] ? (
                      <p className="text-xs text-amber-700 dark:text-amber-300">{codeErrors[index]}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm">{tender.svLast4 ? `…${tender.svLast4}` : '—'}</p>
                )
              ) : editable ? (
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
                <div className="space-y-1">
                  <Input
                    value={tender.reference ?? ''}
                    onChange={(e) => update(index, { reference: e.target.value })}
                    placeholder={t('tenders.referencePlaceholder')}
                  />
                  {(GATEWAY_LIKE_KINDS as readonly string[]).includes(tender.kind) ? (
                    <Input
                      value={tender.externalRef ?? ''}
                      onChange={(e) => update(index, { externalRef: e.target.value })}
                      placeholder={t('tenders.externalRefPlaceholder')}
                    />
                  ) : null}
                </div>
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
        )
      })}
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

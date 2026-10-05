'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect } from '@openbooks/ui'
import { sum } from '@openbooks/engine/money'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
import { useMoney } from '../../../components/money-provider'

/**
 * One applied tender per row: a gift-card code or the customer's store
 * credit, each with its amount. Fresh codes verify on save (the lookup API
 * is a token-authed POS surface, not a session surface); the picker only
 * offers verified store-credit balances. Echoes of already-saved tenders
 * carry the account id — the code itself is shown once at issue.
 */
export interface TenderDraft {
  key: string
  /** Fresh code typed this session; absent for already-saved echoes. */
  code: string | null
  accountId: string | null
  codeLast4: string
  amount: string
  /** Verified available balance in receipt currency, when known. */
  available: string | null
}

export interface CustomerCreditOption {
  accountId: string
  codeLast4: string
  currency: string
  balance: string
}

export function StoredValueTendersSection({ currency, receiptTotal, partyId, drafts, onChange, initialCredits, disabled = false }: {
  currency: string
  receiptTotal: string
  /** The receipt's customer: the picker follows party changes. */
  partyId: string | null
  drafts: TenderDraft[]
  onChange: (drafts: TenderDraft[]) => void
  initialCredits: CustomerCreditOption[]
  disabled?: boolean
}) {
  const t = useTranslations('storedValue')
  const { money } = useMoney(currency)
  const [code, setCode] = useState('')
  const [amount, setAmount] = useState('')
  const [creditId, setCreditId] = useState('')
  const [customerCredits, setCustomerCredits] = useState<CustomerCreditOption[]>(initialCredits)
  const [creditsParty, setCreditsParty] = useState(partyId)
  const canonicalAmounts = drafts.map((draft) => canonicalDecimal(draft.amount, 4))
  const unreadableIndex = canonicalAmounts.findIndex((value) => value === null)
  const tenderRefusal = unreadableIndex < 0 ? null : moneyRefusal(`${t('labels.amount')} (••••-${drafts[unreadableIndex]!.codeLast4})`, drafts[unreadableIndex]!.amount)
  const tendered = tenderRefusal === null ? sum(canonicalAmounts.filter((value): value is string => value !== null)) : null
  const amountRefusal = amount.trim() && canonicalDecimal(amount, 4) === null ? moneyRefusal(t('labels.amount'), amount) : null

  // The picker follows the receipt's party: changing the customer drops the
  // previous customer's credit at render (never offered against the wrong
  // party) and reloads. A failed reload keeps an empty list rather than
  // stranding the operator with stale credit — save-time verification still
  // refuses anything unknown by name.
  if (creditsParty !== partyId) {
    setCreditsParty(partyId)
    setCustomerCredits([])
    setCreditId('')
  }
  const creditsUrl = partyId ? `/api/stored-value/customer-credits?partyId=${encodeURIComponent(partyId)}` : null
  useEffect(() => {
    if (!creditsUrl) return
    const controller = new AbortController()
    fetch(creditsUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const body = await res.json().catch(() => null)
        if (!controller.signal.aborted && Array.isArray(body?.credits)) setCustomerCredits(body.credits)
      })
      .catch(() => null)
    return () => controller.abort()
  }, [creditsUrl])

  function addCode() {
    const trimmed = code.trim()
    if (!trimmed || !amount.trim() || amountRefusal !== null) return
    onChange([...drafts, {
      key: `code-${Date.now()}`,
      code: trimmed,
      accountId: null,
      codeLast4: trimmed.slice(-4),
      amount: amount.trim(),
      available: null,
    }])
    setCode('')
    setAmount('')
  }

  function addCredit() {
    const picked = customerCredits.find((c) => c.accountId === creditId)
    if (!picked) return
    onChange([...drafts, {
      key: `credit-${picked.accountId}`,
      code: null,
      accountId: picked.accountId,
      codeLast4: picked.codeLast4,
      amount: picked.balance,
      available: picked.balance,
    }])
    setCreditId('')
  }

  return (
    <section aria-label={t('payment.tenderLabel')} className="space-y-3">
      {drafts.length === 0 ? (
        <p className="text-sm text-slate-500">{t('payment.tenderPlaceholder')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {drafts.map((draft) => (
            <li key={draft.key} className="flex items-center gap-2 px-3 py-2">
              <span className="text-sm font-medium">••••-{draft.codeLast4}</span>
              {draft.available != null && (
                <span className="text-xs text-slate-500">{t('payment.appliedBalance')}: {money(draft.available, { currency })}</span>
              )}
              <span className="ml-auto" />
              <Input
                className="w-28"
                inputMode="decimal"
                aria-label={t('labels.amount')}
                value={draft.amount}
                disabled={disabled}
                onChange={(e) => onChange(drafts.map((d) => d.key === draft.key ? { ...d, amount: e.target.value } : d))}
              />
              {!disabled && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(drafts.filter((d) => d.key !== draft.key))}
                >
                  {t('payment.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="grid gap-3 rounded-lg border border-dashed border-border p-3">
          <div className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
            <div>
              <Label htmlFor="sv-tender-code">{t('payment.tenderPlaceholder')}</Label>
              <Input id="sv-tender-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="sv-tender-amount">{t('labels.amount')}</Label>
              <Input id="sv-tender-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <Button onClick={addCode} disabled={!code.trim() || !amount.trim() || amountRefusal !== null}>{t('payment.apply')}</Button>
          </div>
          {amountRefusal ? <p role="alert" className="text-sm text-destructive">{amountRefusal}</p> : null}
          {customerCredits.length > 0 && (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <div>
                <Label htmlFor="sv-tender-credit">{t('customer.tabLabel')}</Label>
                <SearchSelect
                  value={creditId}
                  onChange={setCreditId}
                  options={customerCredits.map((c) => ({
                    value: c.accountId,
                    label: `••••-${c.codeLast4} · ${money(c.balance, { currency: c.currency })}`,
                  }))}
                  placeholder={t('customer.tabLabel')}
                  ariaLabel={t('customer.tabLabel')}
                />
              </div>
              <Button variant="outline" onClick={addCredit} disabled={!creditId}>{t('payment.apply')}</Button>
            </div>
          )}
        </div>
      )}
      {tenderRefusal ? <p role="alert" className="text-sm text-destructive">{tenderRefusal}</p> : null}
      {drafts.length > 0 && tendered !== null && (
        <p className="text-sm text-slate-500">
          {t('payment.tenderedOf', { tendered: money(tendered, { currency }), total: money(receiptTotal, { currency }) })}
        </p>
      )}
    </section>
  )
}

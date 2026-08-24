'use client'

import { useMoney } from '@/components/money-provider'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { SortTh } from '../../../components/sortable-th'
/**
 * Payment-run builder: select posted vendor bills with an open balance
 * (across vendors), pick the paying bank account, create the run. Selection
 * is client state keyed by bill id, so it survives URL-driven search/
 * pagination of the underlying list.
 */

export interface RunBill {
  id: string
  document_number: string
  vendor: string
  document_date: string
  due_date: string | null
  reference_number: string | null
  open: string
  currency: string
  has_bank: boolean
}

export function RunBuilder({
  bills,
  bankProfiles,
  sp,
  sort,
  dir,
  toolbar,
  pagination,
  mode = 'payments',
  basePath = '/payments',
  preselected,
}: {
  bills: RunBill[]
  bankProfiles: {
    id: string
    name: string
    currency: string
    format_name: string
    bank_number: string | null
    bank_name: string
  }[]
  sp: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
  toolbar: ReactNode
  pagination: ReactNode
  mode?: 'payments' | 'collections'
  basePath?: string
  /**
   * Bills to pre-check on mount — e.g. handed over from the AP cockpit's
   * pay-run planner. Kept as whole rows so their totals survive pagination.
   */
  preselected?: RunBill[]
}) {
  const { money } = useMoney()
  const t = useTranslations('payments.runBuilder')
  const tCommon = useTranslations('common')
  const router = useRouter()
  /** Selected bills (whole row kept so totals survive pagination). */
  const [selected, setSelected] = useState<Record<string, RunBill>>(() =>
    Object.fromEntries((preselected ?? []).map((b) => [b.id, b])),
  )
  const [paymentBankProfileId, setPaymentBankProfileId] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [captureDiscounts, setCaptureDiscounts] = useState(true)
  const [applyCredits, setApplyCredits] = useState(true)
  const [busy, setBusy] = useState(false)

  const selectedList = Object.values(selected)
  const selectedTotals = selectedList.reduce((totals, bill) => {
    totals.set(bill.currency, (totals.get(bill.currency) ?? 0) + Number(bill.open))
    return totals
  }, new Map<string, number>())
  const selectedAmount = [...selectedTotals].map(([currency, total]) => money(total, { currency })).join(' + ')
  const selectedProfile = bankProfiles.find((profile) => profile.id === paymentBankProfileId)
  const currencyMismatch = !!selectedProfile && selectedList.some((bill) => bill.currency !== selectedProfile.currency)
  const allOnPage = bills.length > 0 && bills.every((b) => selected[b.id])

  function toggle(bill: RunBill) {
    setSelected((prev) => {
      const next = { ...prev }
      if (next[bill.id]) delete next[bill.id]
      else next[bill.id] = bill
      return next
    })
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = { ...prev }
      if (allOnPage) for (const b of bills) delete next[b.id]
      else for (const b of bills) next[b.id] = b
      return next
    })
  }

  async function createRun() {
    setBusy(true)
    const res = await fetch(mode === 'collections' ? '/api/receipts/runs' : '/api/payments/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentBankProfileId,
        ...(mode === 'collections' ? { invoiceDocumentIds: selectedList.map((b) => b.id) } : { billDocumentIds: selectedList.map((b) => b.id) }),
        scheduledFor: scheduledFor || null,
        ...(mode === 'payments' ? { selectionCriteria: { captureDiscounts, applyCredits } } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('toasts.createFailed'))
      setBusy(false)
      return
    }
    toast.success(t('toasts.created', { number: data.runNumber }))
    setSelected({})
    setBusy(false)
    router.push((`${basePath}?view=runs&run=${data.id}`))
    router.refresh()
  }

  const thProps = {
    basePath,
    currentParams: sp,
    sort,
    dir,
    sortParamKey: 'billsSort',
    dirParamKey: 'billsDir',
    pageParamKey: 'billsPage',
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50/50 dark:bg-slate-950/20">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_12rem_minmax(18rem,auto)] lg:items-end">
          <div className="space-y-1.5">
            <Label>
              {t('payFromBankAccount')}<span className="text-red-500"> *</span>
            </Label>
            <SearchSelect
              options={bankProfiles.map((profile) => ({
                value: profile.id,
                label: `${profile.name} · ${`${profile.bank_number ?? ''} ${profile.bank_name}`.trim()} · ${profile.currency} · ${profile.format_name}`,
              }))}
              value={paymentBankProfileId}
              onChange={(v) => setPaymentBankProfileId(v ?? '')}
              placeholder={bankProfiles.length > 0 ? t('selectBankAccountPlaceholder') : t('noBankAccounts')}
              disabled={bankProfiles.length === 0}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fundsDate')}</Label>
            <Input type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
          </div>
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 dark:border-teal-900 dark:bg-teal-950/40">
            <div>
              <p className="text-[11px] font-medium tracking-wide text-teal-700 uppercase dark:text-teal-300">
                {t(mode === 'collections' ? 'selectedForCollection' : 'selectedForPayment')}
              </p>
              <p className="text-sm text-slate-700 tabular-nums dark:text-slate-200">
                {t.rich(mode === 'collections' ? 'collectionSummary' : 'selectionSummary', {
                  count: selectedList.length,
                  amount: selectedAmount,
                  total: (chunks) => <strong className="text-slate-950 dark:text-white">{chunks}</strong>,
                })}
              </p>
            </div>
            <Button disabled={busy || selectedList.length === 0 || !paymentBankProfileId || currencyMismatch} onClick={createRun}>
              {busy ? tCommon('actions.creating') : t(mode === 'collections' ? 'createCollectionRun' : 'createRun')}
            </Button>
          </div>
        </div>
      </div>

      <div className="shrink-0 px-4 py-3 sm:px-6">{toolbar}</div>

      {mode === 'payments' ? <div className="flex shrink-0 flex-wrap gap-x-5 gap-y-2 px-4 pb-3 text-sm text-slate-700 sm:px-6 dark:text-slate-200">
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-600" checked={captureDiscounts} onChange={(e) => setCaptureDiscounts(e.target.checked)} />{t('captureDiscounts')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-600" checked={applyCredits} onChange={(e) => setApplyCredits(e.target.checked)} />{t('applyCredits')}</label>
      </div> : null}

      <div className="min-h-0 flex-1 px-4 pb-3 sm:px-6 [&>div]:h-full [&>div]:overflow-auto">
        {bills.length === 0 ? (
          <div className="flex h-full min-h-48 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            {t(mode === 'collections' ? 'noOpenInvoices' : 'noOpenBills')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={allOnPage}
                    onChange={toggleAll}
                    aria-label={t('selectAllAriaLabel')}
                  />
                </TableHead>
                <SortTh {...thProps} column="number">{t(mode === 'collections' ? 'columns.invoice' : 'columns.bill')}</SortTh>
                <SortTh {...thProps} column="vendor">{mode === 'collections' ? tCommon('labels.customer') : tCommon('labels.vendor')}</SortTh>
                <SortTh {...thProps} column="due">{t('columns.due')}</SortTh>
                <TableHead>{t('columns.ref')}</TableHead>
                <TableHead>{t(mode === 'collections' ? 'columns.mandate' : 'columns.bankDetails')}</TableHead>
                <SortTh {...thProps} column="open" align="right">{t('columns.openBalance')}</SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.map((b) => (
                <TableRow key={b.id} data-state={selected[b.id] ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-teal-600"
                      checked={!!selected[b.id]}
                      onChange={() => toggle(b)}
                      aria-label={t('selectAriaLabel', { document: b.document_number })}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-[13px] font-semibold">{b.document_number}</TableCell>
                  <TableCell>{b.vendor}</TableCell>
                  <TableCell>{b.due_date ?? '—'}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{b.reference_number}</TableCell>
                  <TableCell>
                    {b.has_bank ? (
                      <Badge variant="success">{t(mode === 'collections' ? 'mandateActive' : 'bankApproved')}</Badge>
                    ) : (
                      <Badge variant="warning">{t(mode === 'collections' ? 'mandateMissing' : 'bankMissing')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(b.open, { currency: b.currency })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-1 dark:border-slate-800 dark:bg-slate-900">
        {pagination}
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { SortTh } from '../../../components/sortable-th'
import { money } from '../../../lib/format'

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
  has_bank: boolean
}

export function RunBuilder({
  bills,
  bankAccounts,
  sp,
  sort,
  dir,
}: {
  bills: RunBill[]
  bankAccounts: { id: string; number: string | null; name: string }[]
  sp: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
}) {
  const t = useTranslations('payments.runBuilder')
  const tCommon = useTranslations('common')
  const router = useRouter()
  /** Selected bills (whole row kept so totals survive pagination). */
  const [selected, setSelected] = useState<Record<string, RunBill>>({})
  const [bankAccountId, setBankAccountId] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)

  const selectedList = Object.values(selected)
  const totalSelected = selectedList.reduce((acc, b) => acc + Number(b.open), 0)
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
    const res = await fetch('/api/payments/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId,
        billDocumentIds: selectedList.map((b) => b.id),
        scheduledFor: scheduledFor || null,
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
    router.push(`/payments?view=runs&run=${data.id}` as any)
    router.refresh()
  }

  const thProps = {
    basePath: '/payments',
    currentParams: sp,
    sort,
    dir,
    sortParamKey: 'billsSort',
    dirParamKey: 'billsDir',
    pageParamKey: 'billsPage',
  }

  return (
    <div className="space-y-3">
      {bills.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-3 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {t('noOpenBills')}
        </p>
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
              <SortTh {...thProps} column="number">{t('columns.bill')}</SortTh>
              <SortTh {...thProps} column="vendor">{tCommon('labels.vendor')}</SortTh>
              <SortTh {...thProps} column="due">{t('columns.due')}</SortTh>
              <TableHead>{t('columns.ref')}</TableHead>
              <TableHead>{t('columns.bankDetails')}</TableHead>
              <SortTh {...thProps} column="open" align="right">{t('columns.openBalance')}</SortTh>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bills.map((b) => (
              <TableRow key={b.id}>
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
                    <Badge variant="success">{t('bankApproved')}</Badge>
                  ) : (
                    <Badge variant="warning">{t('bankMissing')}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(b.open)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="w-64 space-y-1.5">
          <Label>
            {t('payFromBankAccount')}<span className="text-red-500"> *</span>
          </Label>
          <SearchSelect
            options={bankAccounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name}`.trim() }))}
            value={bankAccountId}
            onChange={(v) => setBankAccountId(v ?? '')}
            placeholder={t('selectBankAccountPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('fundsDate')}</Label>
          <Input type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
        </div>
        <span className="flex-1" />
        <span className="pb-2 text-sm text-slate-600 tabular-nums dark:text-slate-300">
          {t.rich('selectionSummary', {
            count: selectedList.length,
            amount: money(totalSelected),
            total: (chunks) => <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>,
          })}
        </span>
        <Button disabled={busy || selectedList.length === 0 || !bankAccountId} onClick={createRun}>
          {busy ? tCommon('actions.creating') : t('createRun')}
        </Button>
      </div>
    </div>
  )
}

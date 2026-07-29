'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
export interface UnbilledClient {
  revenue: string
  cost: string
  hours: number
  timeEntryCount: number
  costLineCount: number
}

/** Effective invoicing/backup defaults for this project, resolved through the
 *  project-type ← customer ← project cascade. Seeds the request-billing form. */
export interface EffectiveInvoicingClient {
  billingProcedure: 'standard' | 'application_for_payment'
  allowedBases: string[]
  defaultBasis: string
  backupRequired: boolean
  backupType: string
  allowedBackupTypes: string[]
  source: { basis: string; backupRequired: string; backupType: string; template: string }
}

export interface BillableFieldTicketClient {
  id: string
  documentNumber: string
  documentDate: string
  periodStart: string
  periodEnd: string
  customerSigned: boolean
  unbilledHours: string
}

export interface BillingRequestClient {
  id: string
  requestNumber: string
  invoiceType: string
  basis: string
  drawAmount: string | null
  startDate: string | null
  cutoffDate: string | null
  backupRequired: boolean
  backupType: string
  status: string
  invoiceDocumentId: string | null
  invoiceNumber: string | null
  invoiceStatus: string | null
  invoiceTotal: string | null
  fieldTicketCount: number
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'warning',
  invoiced: 'success',
  closed: 'secondary',
  cancelled: 'outline',
}

const field = 'space-y-1.5'

export function BillingSection({
  projectId,
  unbilled,
  requests,
  fieldTickets,
  invoicing,
  canManage,
  formOpen,
  onFormOpenChange,
}: {
  projectId: string
  unbilled: UnbilledClient
  requests: BillingRequestClient[]
  fieldTickets: BillableFieldTicketClient[]
  invoicing: EffectiveInvoicingClient
  canManage: boolean
  /** Request-billing form is opened from the flyout Actions menu. */
  formOpen: boolean
  onFormOpenChange: (open: boolean) => void
}) {
  const { money } = useMoney()
  const t = useTranslations('projects.billing')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  // Seed the request-billing form from the resolved cascade defaults.
  const [invoiceType, setInvoiceType] = useState('progress')
  const [basis, setBasis] = useState(invoicing.defaultBasis)
  const [drawAmount, setDrawAmount] = useState('')
  const [startDate, setStartDate] = useState('')
  const [cutoffDate, setCutoffDate] = useState('')
  const [invoiceDescription, setInvoiceDescription] = useState('')
  const [customerPo, setCustomerPo] = useState('')
  const [backupRequired, setBackupRequired] = useState(invoicing.backupRequired)
  const [backupType, setBackupType] = useState(invoicing.backupType)
  const [selectedFieldTicketIds, setSelectedFieldTicketIds] = useState<Set<string>>(new Set())

  // The project type constrains which backup formats are offered; fall back to the
  // full catalog if it didn't restrict them. 'none' is handled by the required toggle.
  const ALL_BACKUP_TYPES = ['costed_timesheets', 'timesheets_purchases', 'purchases', 'purchases_shop_time', 'quote_only']
  const allowed = invoicing.allowedBackupTypes.filter((b) => b !== 'none')
  const backupTypeOptions = allowed.length ? allowed : ALL_BACKUP_TYPES
  // Fail closed when setup resolves to no available basis (for example, the
  // type only allows Field Tickets while that subordinate feature is off).
  const basisOptions = invoicing.allowedBases

  function toggleFieldTicket(id: string) {
    setSelectedFieldTicketIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (invoicing.billingProcedure === 'application_for_payment') {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Applications for payment</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              This project bills from a Schedule of Values using cumulative applications, change orders, and retainage. Interim and final are application stages, not separate billing methods.
            </p>
            <Button asChild className="mt-4"><Link href={`/construction?projectId=${projectId}`}>Open applications for payment</Link></Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  async function submit() {
    setBusy(true)
    const res = await fetch('/api/billing-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        invoiceType,
        basis,
        drawAmount: basis === 'draw_amount' ? drawAmount || null : null,
        startDate: basis === 'date_range' ? startDate || null : null,
        cutoffDate: basis === 'date_range' ? cutoffDate || null : null,
        invoiceDescription: invoiceDescription || null,
        customerPo: customerPo || null,
        backupRequired,
        backupType: backupRequired ? backupType : 'none',
        fieldTicketIds: basis === 'field_ticket' ? [...selectedFieldTicketIds] : [],
      }),
    })
    if (res.ok) {
      toast.success(t('requestCreated'))
      setSelectedFieldTicketIds(new Set())
      onFormOpenChange(false)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('requestFailed'))
    }
    setBusy(false)
  }

  async function createInvoice(id: string) {
    setBusy(true)
    const res = await fetch(`/api/billing-requests/${id}/create-invoice`, { method: 'POST' })
    const data = await res.json()
    setBusy(false)
    if (res.ok && data.documentId) {
      toast.success(t('invoiceCreated', { number: data.documentNumber }))
      router.push(`/ar/invoices?doc=${data.documentId}&mode=edit`)
    } else {
      toast.error(data.error ?? t('invoiceFailed'))
    }
  }

  async function cancelRequest(id: string) {
    setBusy(true)
    const res = await fetch(`/api/billing-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })
    setBusy(false)
    if (res.ok) router.refresh()
    else toast.error((await res.json()).error ?? t('requestFailed'))
  }

  const statusLabel = (s: string) => {
    try {
      return t(`status.${s}`)
    } catch {
      return s
    }
  }

  return (
    <div className="space-y-6">
      {/* Unbilled banner (no inline trigger — Request billing lives in the Actions menu). */}
      <Card>
        <CardContent className="p-4">
          <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {t('availableToBill')}
          </div>
          <div className="text-2xl font-semibold tabular-nums text-teal-700 dark:text-teal-300">
            {money(unbilled.revenue)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t('unbilledDetail', {
              entries: unbilled.timeEntryCount,
              hours: unbilled.hours.toFixed(1),
              lines: unbilled.costLineCount,
            })}
          </div>
        </CardContent>
      </Card>

      {/* Request-billing form — opened from the Actions menu. */}
      {formOpen ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('requestBilling')}</h3>
              <Button variant="ghost" size="sm" onClick={() => onFormOpenChange(false)} disabled={busy}>{tCommon('actions.cancel')}</Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                <Label>{t('invoiceType')}</Label>
                <Select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}>
                  <option value="progress">{t('type.progress')}</option>
                  <option value="final">{t('type.final')}</option>
                </Select>
              </div>
              <div className={field}>
                <Label>{t('basis')}</Label>
                <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                  {basisOptions.map((b) => (
                    <option key={b} value={b}>{t(`basisOpt.${b}`)}</option>
                  ))}
                </Select>
              </div>
              {basis === 'draw_amount' ? (
                <div className={field}>
                  <Label>{t('drawAmount')}</Label>
                  <Input inputMode="decimal" className="text-right tabular-nums" value={drawAmount} onChange={(e) => setDrawAmount(e.target.value)} />
                </div>
              ) : null}
              {basis === 'date_range' ? (
                <>
                  <div className={field}>
                    <Label>{t('startDate')}</Label>
                    <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div className={field}>
                    <Label>{t('cutoffDate')}</Label>
                    <Input type="date" value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)} />
                  </div>
                </>
              ) : null}
              {basis === 'field_ticket' ? (
                <div className={`${field} sm:col-span-2 lg:col-span-4`}>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <Label>{t('fieldTickets')}</Label>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('fieldTicketHint')}</p>
                    </div>
                    {fieldTickets.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedFieldTicketIds(
                          selectedFieldTicketIds.size === fieldTickets.length
                            ? new Set()
                            : new Set(fieldTickets.map((ticket) => ticket.id)),
                        )}
                      >
                        {selectedFieldTicketIds.size === fieldTickets.length
                          ? tCommon('actions.clear')
                          : t('selectAll')}
                      </Button>
                    ) : null}
                  </div>
                  {fieldTickets.length === 0 ? (
                    <div className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                      {t('noBillableFieldTickets')}
                    </div>
                  ) : (
                    <div className="max-h-64 divide-y divide-slate-200 overflow-y-auto rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                      {fieldTickets.map((ticket) => (
                        <label key={ticket.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-900/60">
                          <input
                            type="checkbox"
                            checked={selectedFieldTicketIds.has(ticket.id)}
                            onChange={() => toggleFieldTicket(ticket.id)}
                            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {ticket.documentNumber}
                            </span>
                            <span className="block text-xs text-slate-500 dark:text-slate-400">
                              {ticket.periodStart} – {ticket.periodEnd} · {Number(ticket.unbilledHours).toFixed(1)}h
                            </span>
                          </span>
                          <Badge variant={ticket.customerSigned ? 'success' : 'outline'}>
                            {ticket.customerSigned ? t('customerSigned') : t('customerUnsigned')}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div className={`${field} lg:col-span-2`}>
                <Label>{t('description')}</Label>
                <Input value={invoiceDescription} onChange={(e) => setInvoiceDescription(e.target.value)} />
              </div>
              <div className={field}>
                <Label>{t('customerPo')}</Label>
                <Input value={customerPo} onChange={(e) => setCustomerPo(e.target.value)} />
              </div>
              <div className={field}>
                <Label>{t('backupRequired')}</Label>
                <Select value={backupRequired ? 'yes' : 'no'} onChange={(e) => setBackupRequired(e.target.value === 'yes')}>
                  <option value="yes">{tCommon('labels.yes')}</option>
                  <option value="no">{tCommon('labels.no')}</option>
                </Select>
              </div>
              {backupRequired ? (
                <div className={field}>
                  <Label>{t('backupType')}</Label>
                  <Select value={backupType} onChange={(e) => setBackupType(e.target.value)}>
                    {backupTypeOptions.map((bt) => (
                      <option key={bt} value={bt}>{t(`backup.${bt}`)}</option>
                    ))}
                  </Select>
                </div>
              ) : null}
            </div>
            {basisOptions.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {t('noAvailableBasis')}
              </p>
            ) : null}
            <Button
              onClick={submit}
              disabled={
                busy
                || !basisOptions.includes(basis)
                || (basis === 'field_ticket' && selectedFieldTicketIds.size === 0)
              }
            >
              {busy ? tCommon('actions.saving') : t('createRequest')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Requests table */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('requests')}</h3>
        <PagedTable
          rows={requests}
          rowKey={(r) => r.id}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('noRequests')}</p>}
          columns={[
            { key: 'number', header: tCommon('labels.number'), cell: (r) => <span className="font-mono text-[13px] font-semibold">{r.requestNumber}</span>, search: (r) => r.requestNumber },
            { key: 'type', header: t('invoiceType'), cell: (r) => t(`type.${r.invoiceType}`) },
            {
              key: 'basis',
              header: t('basis'),
              cell: (r) => (
                <span className="text-slate-600 dark:text-slate-300">
                  {t(`basisOpt.${r.basis}`)}
                  {r.basis === 'field_ticket' ? ` · ${t('ticketCount', { count: r.fieldTicketCount })}` : ''}
                </span>
              ),
            },
            { key: 'backup', header: t('backupType'), cell: (r) => <span className="text-slate-600 dark:text-slate-300">{r.backupRequired ? t(`backup.${r.backupType}`) : '—'}</span> },
            { key: 'status', header: tCommon('labels.status'), cell: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{statusLabel(r.status)}</Badge> },
            {
              key: 'invoice', header: t('invoice'),
              cell: (r) => r.invoiceDocumentId ? (
                <Link href={`/ar?invoice=${r.invoiceDocumentId}`} className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300">{r.invoiceNumber}</Link>
              ) : '—',
            },
            {
              key: 'actions', header: tCommon('labels.actions'), align: 'right',
              cell: (r) => (
                <div className="flex items-center justify-end gap-2">
                  {r.status === 'open' && canManage ? (
                    <>
                      <Button size="sm" onClick={() => createInvoice(r.id)} disabled={busy}>{t('createInvoice')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => cancelRequest(r.id)} disabled={busy}>{tCommon('actions.cancel')}</Button>
                    </>
                  ) : null}
                  {r.status === 'invoiced' && r.backupRequired ? (
                    <a href={`/api/billing-requests/${r.id}/backup`} target="_blank" rel="noreferrer">
                      <Button size="sm" variant="outline">{t('downloadBackup')}</Button>
                    </a>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronUp, CreditCard } from 'lucide-react'
import { fetchAction, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, DisclosureSection, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { useAppAction } from '../../../lib/use-app-action'
import { readApiErrorMessage } from '../../../lib/api-error'
import { confirmDialog } from '../../../lib/confirm'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError, SublistLoading, SublistPager, useSublistRows } from '../../../components/drawer-sublist'
import { AddPaymentMethodDrawer, providerLabel } from './PartyAddPaymentMethodDrawer'

interface StoredMethodRow {
  id: string
  provider: string
  providerCustomerId: string | null
  providerMethodId: string | null
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  mandateReference: string | null
  isDefault: boolean
  fallbackPriority: number
  createdAt: string
  status: string
}

function methodTitle(method: StoredMethodRow): string {
  if (method.brand && method.last4) return `${method.brand} •••• ${method.last4}`
  if (method.last4) return `•••• ${method.last4}`
  if (method.mandateReference) return method.mandateReference
  return providerLabel(method.provider)
}

/**
 * Stored payment methods on a customer drawer. Methods are tokens at the
 * provider (brand, last four, expiry) — full numbers never reach OpenBooks.
 * Writes ride the autopay API routes, which re-check every grant and
 * refusal the panel gates on. Autopay enrollments live in PartyAutopayPanel
 * behind the same tab's second sub-tab, never stacked with the methods.
 * New methods start from the Add payment method drawer, which sends the
 * customer a hosted setup link.
 */
export function PartyPaymentMethodsPanel({
  partyId,
  canManageMethods,
  revision = 0,
  onChanged,
}: {
  partyId: string
  canManageMethods: boolean
  /** Bumped when payment methods change elsewhere in the drawer. */
  revision?: number
  /** Called after a method is added, reordered, defaulted or removed; the
   *  drawer bumps `revision` so every payment-method panel re-reads. */
  onChanged?: () => void
}) {
  const t = useTranslations('parties.drawer.autopay')
  const tc = useTranslations('common')
  const { busy, refusal, execute } = useAppAction()
  const [methods, setMethods] = useState<StoredMethodRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'pending'>('')

  // The mount effect keeps its promise-chain shape, which never resets state
  // synchronously inside the effect body; mutations refresh through the
  // same reload and apply pair.
  const reload = useCallback(async (signal?: AbortSignal) => {
    const methodsRes = await fetch(`/api/autopay/methods?partyId=${encodeURIComponent(partyId)}`, { signal })
    if (!methodsRes.ok) throw new Error(await readApiErrorMessage(methodsRes, t('loadFailed')))
    const methodsBody = (await methodsRes.json()) as { methods?: StoredMethodRow[] }
    return methodsBody.methods ?? []
  }, [partyId, t])

  const applyLoaded = useCallback((applied: StoredMethodRow[]) => {
    setMethods(applied)
    setLoadError(null)
  }, [])

  const applyRefusal = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    setLoadError(error instanceof Error ? error.message : t('loadFailed'))
    setMethods(null)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(applyLoaded, applyRefusal)
    return () => controller.abort()
  }, [reload, applyLoaded, applyRefusal, revision])

  function refresh(): void {
    void reload().then(applyLoaded, applyRefusal)
  }

  function changed(): void {
    if (onChanged) onChanged()
    else refresh()
  }

  async function setDefault(methodId: string) {
    await execute(() => fetchAction(`/api/autopay/methods/${methodId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    }), {
      fallbackMessage: t('setDefaultFailed'),
      onOk: () => changed(),
    })
  }

  async function moveBackup(methodId: string, direction: -1 | 1) {
    const ordered = [...backups]
    const at = ordered.findIndex((method) => method.id === methodId)
    const swap = at + direction
    if (at < 0 || swap < 0 || swap >= ordered.length) return
    const moved = ordered[at]!
    ordered[at] = ordered[swap]!
    ordered[swap] = moved
    // Renumber the chain in its new order so equal priorities can never hide
    // a move; only rows whose value changes are written.
    const updates = ordered
      .map((method, index) => ({ method, index }))
      .filter(({ method, index }) => method.fallbackPriority !== index)
    await execute(async (): Promise<ActionResult<unknown>> => {
      let last: ActionResult<unknown> = { ok: true, status: 200, data: null }
      for (const { method, index } of updates) {
        last = await fetchAction(`/api/autopay/methods/${method.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fallbackPriority: index }),
        })
        // A refused renumber stops the chain: the row order on screen
        // already moved, and the refresh below re-reads the stored order.
        if (!last.ok) return last
      }
      return last
    }, {
      fallbackMessage: t('reorderFailed'),
    })
    changed()
  }

  async function remove(method: StoredMethodRow) {
    const confirmed = await confirmDialog({
      title: t('removeTitle'),
      message: t('removeMessage'),
      confirmLabel: t('remove'),
      cancelLabel: tc('actions.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    await execute(() => fetchAction(`/api/autopay/methods/${method.id}`, { method: 'DELETE' }), {
      fallbackMessage: t('removeFailed'),
      onOk: () => changed(),
    })
  }

  const loaded = methods !== null
  const defaultMethod = methods?.find((method) => method.isDefault && method.status === 'active')
  // The backup chain in charge order: the default always charges first, then
  // active backups by priority with creation time breaking ties — the same
  // order the collection run uses, so what the operator sees is what charges.
  const backups = (methods ?? [])
    .filter((method) => !method.isDefault && method.status === 'active')
    .sort((a, b) => a.fallbackPriority - b.fallbackPriority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  const backupRank = new Map(backups.map((method, index) => [method.id, index]))

  const filteredMethods = useMemo(
    () => (methods ?? []).filter((method) => !statusFilter || (statusFilter === 'active' ? method.status === 'active' : method.status !== 'active')),
    [methods, statusFilter],
  )
  const methodText = useCallback((method: StoredMethodRow) => `${methodTitle(method)} ${providerLabel(method.provider)}`, [])
  const list = useSublistRows(filteredMethods, methodText)
  const addButton = canManageMethods ? <SublistAddButton label={t('addMethod')} onClick={() => setAdding(true)} /> : undefined

  return (
    <>
      <DrawerSublist
        title={t('heading')}
        description={t('description')}
        icon={<CreditCard size={16} />}
        action={addButton}
        alert={refusal?.serverMessage ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{refusal.serverMessage}</p>
        ) : null}
        search={methods?.length ? { value: list.query, onChange: list.setQuery, placeholder: t('search') } : undefined}
        filters={methods?.length ? (
          <Select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); list.setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.status')}>
            <option value="">{t('allStatuses')}</option>
            <option value="active">{t('active')}</option>
            <option value="pending">{t('awaitingCustomer')}</option>
          </Select>
        ) : null}
        footer={methods?.length ? (
          <div className="space-y-3">
            <SublistPager page={list.page} pages={list.pages} onPage={list.setPage} />
            {backups.length > 0 ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('backupDescription')}</p> : null}
            {defaultMethod?.providerCustomerId || defaultMethod?.providerMethodId ? (
              <DisclosureSection title={t('providerDetail')} summary={t('providerDetailSummary')}>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500 dark:text-slate-400">{t('providerCustomer')}</dt>
                  <dd className="break-all text-slate-900 dark:text-slate-100">{defaultMethod.providerCustomerId ?? '—'}</dd>
                  <dt className="text-slate-500 dark:text-slate-400">{t('providerMethod')}</dt>
                  <dd className="break-all text-slate-900 dark:text-slate-100">{defaultMethod.providerMethodId ?? '—'}</dd>
                </dl>
              </DisclosureSection>
            ) : null}
          </div>
        ) : null}
      >
        {!loaded ? (
          loadError ? <SublistLoadError message={loadError} onRetry={refresh} /> : <SublistLoading />
        ) : methods.length === 0 ? (
          <SublistEmpty icon={<CreditCard size={22} />} text={t('emptyTitle')} hint={t('emptyDescription')} action={addButton} />
        ) : list.shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{tc('feedback.noResults')}</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('method')}</TableHead>
              <TableHead>{t('provider')}</TableHead>
              <TableHead>{t('details')}</TableHead>
              <TableHead>{tc('labels.status')}</TableHead>
              {canManageMethods ? <TableHead className="text-right">{tc('labels.actions')}</TableHead> : null}
            </TableRow></TableHeader>
            <TableBody>
              {list.shown.map((method) => (
                <TableRow key={method.id}>
                  <TableCell className="font-medium text-slate-900 dark:text-slate-100">{methodTitle(method)}</TableCell>
                  <TableCell>{providerLabel(method.provider)}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {method.expMonth && method.expYear
                      ? t('expires', { month: method.expMonth, year: method.expYear })
                      : method.mandateReference
                        ? t('mandate', { ref: method.mandateReference })
                        : t('noExpiry')}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={method.status === 'active' ? 'success' : 'secondary'}>
                        {method.status === 'active' ? t('active') : t('awaitingCustomer')}
                      </Badge>
                      {method.isDefault ? <Badge variant="default">{t('defaultBadge')}</Badge> : null}
                      {backupRank.has(method.id) ? (
                        <Badge variant="secondary">{t('backupPosition', { n: (backupRank.get(method.id) ?? 0) + 1 })}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  {canManageMethods ? (
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {backupRank.has(method.id) ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy || (backupRank.get(method.id) ?? 0) === 0}
                              onClick={() => void moveBackup(method.id, -1)}
                              aria-label={t('moveUp')}
                              title={t('moveUp')}
                            >
                              <ChevronUp size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy || (backupRank.get(method.id) ?? 0) === backups.length - 1}
                              onClick={() => void moveBackup(method.id, 1)}
                              aria-label={t('moveDown')}
                              title={t('moveDown')}
                            >
                              <ChevronDown size={14} />
                            </Button>
                          </>
                        ) : null}
                        {!method.isDefault && method.status === 'active' ? (
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => void setDefault(method.id)}>
                            {t('setDefault')}
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(method)}>
                          {t('remove')}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DrawerSublist>
      {canManageMethods ? (
        <AddPaymentMethodDrawer partyId={partyId} open={adding} onClose={() => setAdding(false)} onCreated={changed} />
      ) : null}
    </>
  )
}

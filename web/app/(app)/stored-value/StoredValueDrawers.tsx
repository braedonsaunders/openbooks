'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge, Button, DisclosureSection, EmptyState, Input, Label, SearchSelect, UrlDrawer,
} from '@openbooks/ui'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { PagedTable } from '../../../components/paged-table'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'
import type { StoredValueDrawerData, StoredValueIssueData } from './view'

/**
 * The stored-value account drawer: balance first, then the ledger, then a
 * correction tab, then program and posting detail behind a disclosure. One
 * shell through loading, success, refusal and retry; the loader owns the
 * payload, this owns tab state and mutations.
 */
export function StoredValueDrawer({ drawer }: { drawer: StoredValueDrawerData }) {
  const t = useTranslations('storedValue')
  const common = useTranslations('common')
  const router = useRouter()
  const { account, program, entries } = drawer
  const [tab, setTab] = useState<'ledger' | 'adjust' | 'details'>('ledger')
  const [busy, setBusy] = useState(false)

  async function postStatus(to: 'active' | 'frozen' | 'closed') {
    if (to === 'closed') {
      const ok = await confirmDialog({ title: t('drawer.close'), message: t('drawer.closeConfirm'), confirmLabel: t('drawer.close') })
      if (!ok) return
    }
    let reason: string | null = null
    if (to !== 'active') {
      reason = await promptDialog({ title: t(`drawer.${to === 'closed' ? 'close' : 'freeze'}`), label: t('labels.reason'), confirmLabel: common('actions.confirm') })
      if (reason === null) return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/stored-value/accounts/${account.id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, reason: reason || undefined }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? res.statusText)
      }
      toast.success(t(`status.${to}`))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const variant = account.status === 'active' ? 'success' : account.status === 'frozen' ? 'warning' : account.status === 'expired' ? 'secondary' : 'outline'
  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={<span className="flex items-center gap-2">••••-{account.codeLast4}<Badge variant={variant}>{account.statusLabel}</Badge></span>}
      description={`${account.kindLabel}${account.customerName ? ` · ${account.customerName}` : ''}`}
      headerActions={drawer.canManage ? (
        <span className="flex gap-2">
          {account.status === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => postStatus('frozen')}>{t('drawer.freeze')}</Button>}
          {account.status === 'frozen' && <Button size="sm" variant="outline" disabled={busy} onClick={() => postStatus('active')}>{t('drawer.unfreeze')}</Button>}
          {(account.status === 'active' || account.status === 'frozen') && <Button size="sm" variant="outline" disabled={busy} onClick={() => postStatus('closed')}>{t('drawer.close')}</Button>}
        </span>
      ) : null}
    >
      <dl className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-slate-500">{t('labels.balance')}</dt>
          <dd className="text-lg font-semibold tabular-nums">{account.balanceDisplay}</dd>
          {account.functionalCurrency !== account.currency && (
            <dd className="text-xs tabular-nums text-slate-500">≈ {account.balanceFunctionalDisplay}</dd>
          )}
        </div>
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-slate-500">{t('labels.issued')}</dt>
          <dd className="text-lg font-semibold tabular-nums">{account.issuedDisplay}</dd>
        </div>
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-slate-500">{t('drawer.breakageRecognized')}</dt>
          <dd className="text-lg font-semibold tabular-nums">{account.breakageDisplay}</dd>
        </div>
      </dl>
      <DrawerTabStrip
        ariaLabel={account.codeLast4}
        activeKey={tab}
        onSelect={setTab}
        tabs={[
          { key: 'ledger', label: t('drawer.ledgerTitle') },
          { key: 'adjust', label: t('drawer.adjust'), disabled: !drawer.canAdjust },
          { key: 'details', label: t('drawer.accountSection') },
        ]}
      />
      {tab === 'ledger' && (
        <section aria-label={t('drawer.ledgerTitle')}>
          <p className="mb-2 text-sm text-slate-500">{t('drawer.ledgerDescription')}</p>
          <PagedTable
            rows={entries}
            rowKey={(row) => row.id}
            pageSize={20}
            empty={<EmptyState title={t('drawer.ledgerTitle')} description={t('drawer.ledgerDescription')} />}
            columns={[
              { key: 'createdAt', header: t('labels.postingDate'), cell: (row) => <span className="whitespace-nowrap">{row.createdAt}</span> },
              { key: 'kind', header: t('labels.entryKind'), cell: (row) => row.kindLabel },
              { key: 'amount', header: t('labels.amount'), align: 'right', cell: (row) => <span className="tabular-nums">{row.amountDisplay}</span> },
              { key: 'balance', header: t('labels.newBalance'), align: 'right', cell: (row) => <span className="tabular-nums">{row.balanceAfterDisplay}</span> },
              { key: 'reason', header: t('labels.reason'), cell: (row) => row.reason ?? '—' },
            ]}
          />
        </section>
      )}
      {drawer.canAdjust && (
        <div hidden={tab !== 'adjust'}>
          <AdjustForm
            key={account.id}
            accountId={account.id}
            currency={account.currency}
            liabilityAccountName={program?.liabilityAccountName ?? null}
            offsetAccounts={drawer.offsetAccounts}
          />
        </div>
      )}
      {tab === 'details' && program && (
        <section aria-label={t('drawer.accountSection')} className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-slate-500">{t('drawer.programSection')}</dt><dd className="font-medium">{program.name}</dd></div>
            <div><dt className="text-slate-500">{common('labels.subsidiary')}</dt><dd className="font-medium">{account.subsidiaryName}</dd></div>
            <div><dt className="text-slate-500">{t('labels.expires')}</dt><dd className="font-medium">{account.expiresOn ?? t('drawer.noExpiry')}</dd></div>
            <div><dt className="text-slate-500">{t('labels.lastActivity')}</dt><dd className="font-medium">{account.lastActivityOn}</dd></div>
            {account.customerName && <div><dt className="text-slate-500">{t('labels.customer')}</dt><dd className="font-medium">{account.customerName}</dd></div>}
            <div><dt className="text-slate-500">{t('labels.functionalEquivalent')}</dt><dd className="font-medium tabular-nums">{account.balanceFunctionalDisplay}</dd></div>
          </dl>
          <DisclosureSection
            title={t('drawer.postingDetail')}
            summary={`${account.balanceDisplay} → ${account.balanceFunctionalDisplay}`}
          >
            <p className="mb-2 text-sm text-slate-500">{t('drawer.postingDetailDescription')}</p>
            <PagedTable
              rows={entries}
              rowKey={(row) => row.id}
              pageSize={20}
              empty={<EmptyState title={t('drawer.ledgerTitle')} description={t('drawer.ledgerDescription')} />}
              columns={[
                { key: 'createdAt', header: t('labels.postingDate'), cell: (row) => <span className="whitespace-nowrap">{row.createdAt}</span> },
                { key: 'kind', header: t('labels.entryKind'), cell: (row) => row.kindLabel },
                { key: 'functional', header: t('labels.functionalAmount'), align: 'right', cell: (row) => <span className="tabular-nums">{row.functionalDisplay}</span> },
                { key: 'rate', header: common('labels.rate'), align: 'right', cell: (row) => <span className="tabular-nums">{row.rateDisplay}</span> },
              ]}
            />
          </DisclosureSection>
          <DisclosureSection
            title={t('drawer.programSection')}
            summary={`${program.breakagePolicyLabel} · ${program.liabilityAccountName ?? '—'}`}
          >
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-slate-500">{t('labels.liabilityAccount')}</dt><dd className="font-medium">{program.liabilityAccountName ?? '—'}</dd></div>
              <div><dt className="text-slate-500">{t('labels.breakageIncomeAccount')}</dt><dd className="font-medium">{program.breakageIncomeAccountName ?? '—'}</dd></div>
              <div><dt className="text-slate-500">{t('labels.breakagePolicy')}</dt><dd className="font-medium">{program.breakagePolicyLabel}</dd></div>
              <div><dt className="text-slate-500">{t('labels.breakageRate')}</dt><dd className="font-medium">{program.breakageRateDisplay}</dd></div>
              <div><dt className="text-slate-500">{t('labels.expiryMonths')}</dt><dd className="font-medium">{program.expiryMonths ?? t('drawer.noExpiry')}</dd></div>
              <div><dt className="text-slate-500">{t('labels.inactivityMonths')}</dt><dd className="font-medium">{program.inactivityMonths}</dd></div>
            </dl>
          </DisclosureSection>
        </section>
      )}
    </UrlDrawer>
  )
}

/** Correction outside any document: signed amount, mandatory reason, and the
 *  journal preview before commit. The server refuses unknown accounts and
 *  empty reasons by name; this surfaces that refusal verbatim. */
function AdjustForm({ accountId, currency, liabilityAccountName, offsetAccounts }: {
  accountId: string; currency: string; liabilityAccountName: string | null; offsetAccounts: { id: string; name: string }[]
}) {
  const t = useTranslations('storedValue')
  const common = useTranslations('common')
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [offsetId, setOffsetId] = useState('')
  const [busy, setBusy] = useState(false)
  const offsetName = offsetAccounts.find((a) => a.id === offsetId)?.name ?? null
  const valid = amount.trim() !== '' && reason.trim().length >= 8 && offsetId !== ''

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/stored-value/accounts/${accountId}/adjust`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delta: amount.trim(),
          reason: reason.trim(),
          offsetAccountId: offsetId,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? res.statusText)
      }
      toast.success(t('entryKind.adjust'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('drawer.adjust')} className="space-y-4">
      <p className="text-sm text-slate-500">{t('drawer.adjustDescription')}</p>
      <div className="grid gap-3">
        <div>
          <Label htmlFor="sv-adjust-amount">{t('drawer.adjustAmount')} ({currency})</Label>
          <Input id="sv-adjust-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00 / -10.00" />
        </div>
        <div>
          <Label htmlFor="sv-adjust-offset">{t('labels.offsetAccount')}</Label>
          <SearchSelect
            value={offsetId}
            onChange={setOffsetId}
            options={offsetAccounts.map((a) => ({ value: a.id, label: a.name }))}
            placeholder={t('labels.offsetAccount')}
            ariaLabel={t('labels.offsetAccount')}
          />
        </div>
        <div>
          <Label htmlFor="sv-adjust-reason">{t('drawer.adjustReason')}</Label>
          <Input id="sv-adjust-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('drawer.adjustReason')} />
        </div>
      </div>
      {valid && (
        <p className="rounded-lg border border-border bg-slate-50 p-3 text-sm dark:bg-slate-900">
          {t('labels.debitAccount')}: {offsetName} · {t('labels.liabilityAccount')}: {liabilityAccountName ?? '—'} · {t('labels.amount')}: {amount.trim()} {currency}
        </p>
      )}
      <Button onClick={submit} disabled={!valid || busy}>{busy ? common('actions.saving') : t('drawer.adjust')}</Button>
    </section>
  )
}

/**
 * "Sell a gift card": mint a code with a starting balance in one drawer. The
 * plaintext code renders exactly once with a copy affordance — the list and
 * the account drawer only ever show the last four.
 */
export function StoredValueIssueDrawer({ issue }: { issue: StoredValueIssueData }) {
  const t = useTranslations('storedValue')
  const common = useTranslations('common')
  const router = useRouter()
  const [programId, setProgramId] = useState(issue.programs[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [debitId, setDebitId] = useState(issue.debitAccounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const program = issue.programs.find((p) => p.id === programId) ?? null
  const storeCredit = program?.kind === 'store_credit'
  const valid = programId !== '' && amount.trim() !== '' && debitId !== '' && (!storeCredit || customerId !== '')

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/stored-value/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          programId,
          amount: amount.trim(),
          currency: program?.currency,
          customerPartyId: storeCredit ? customerId : undefined,
          debitAccountId: debitId,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? res.statusText)
      }
      const body = await res.json()
      setCode(String(body.code))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer open closeHref={issue.closeHref} title={t('issue.title')} description={t('issue.description')}>
      {code ? (
        <section className="space-y-3" aria-label={t('issue.codeShownOnce')}>
          <EmptyState
            title={t('issue.codeShownOnce')}
            description={code}
            action={(
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(code).catch(() => null)
                  toast.success(t('issue.codeCopied'))
                }}
              >
                {t('issue.codeCopied')}
              </Button>
            )}
          />
        </section>
      ) : (
        <section className="space-y-4" aria-label={t('issue.title')}>
          <div>
            <Label htmlFor="sv-issue-program">{t('issue.programLabel')}</Label>
            <SearchSelect
              value={programId}
              onChange={setProgramId}
              options={issue.programs.map((p) => ({ value: p.id, label: `${p.name} · ${p.kindLabel}` }))}
              placeholder={t('issue.programLabel')}
              ariaLabel={t('issue.programLabel')}
            />
          </div>
          <div>
            <Label htmlFor="sv-issue-amount">{t('issue.amountLabel')}{program ? ` (${program.currency})` : ''}</Label>
            <Input id="sv-issue-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50.00" />
          </div>
          {storeCredit && (
            <div>
              <Label htmlFor="sv-issue-customer">{t('issue.customerLabel')}</Label>
              <SearchSelect
                value={customerId}
                onChange={setCustomerId}
                options={issue.customers.map((c) => ({ value: c.id, label: c.name }))}
                placeholder={t('issue.customerLabel')}
                ariaLabel={t('issue.customerLabel')}
              />
            </div>
          )}
          <div>
            <Label htmlFor="sv-issue-debit">{t('labels.debitAccount')}</Label>
            <SearchSelect
              value={debitId}
              onChange={setDebitId}
              options={issue.debitAccounts.map((a) => ({ value: a.id, label: a.name }))}
              placeholder={t('labels.debitAccount')}
              ariaLabel={t('labels.debitAccount')}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={submit} disabled={!valid || busy}>{busy ? common('actions.saving') : t('issue.submit')}</Button>
            <Button variant="outline" onClick={() => router.push(issue.closeHref as never)}>{t('issue.cancel')}</Button>
          </div>
        </section>
      )}
    </UrlDrawer>
  )
}

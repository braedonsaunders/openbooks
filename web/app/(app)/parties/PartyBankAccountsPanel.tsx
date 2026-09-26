'use client'

/** Split from PartyDrawer.tsx; moved without behavior changes. */
import { type BankAccountClient, field } from './party-drawer-model'
import { SublistHeading, SublistEmpty } from './PartySummary'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Landmark, Plus, Search } from 'lucide-react'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { Badge, Button, Drawer, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { currencyOptions } from '../../../lib/iso-currencies'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { countryOptions } from '../../../lib/countries'
import { promptDialog } from '../../../lib/prompt'

interface BankAccountDraft {
  id: string | null
  bankName: string
  country: string
  currency: string
  routingNumber: string
  branchNumber: string
  accountNumber: string
  routingBase: Record<string, string>
  lastFour: string
  updatedAt: string
}

const emptyBankDraft = (): BankAccountDraft => ({
  id: null, bankName: '', country: '', currency: '', routingNumber: '', branchNumber: '',
  accountNumber: '', routingBase: {}, lastFour: '', updatedAt: '',
})

export function BankAccountsPanel({
  partyId,
  initialAccounts,
  canManage,
  multiCurrency = false,
  readOnly = false,
}: {
  partyId: string
  initialAccounts: BankAccountClient[]
  canManage: boolean
  multiCurrency?: boolean
  /**
   * The employee drawer read mode: values only — no add/edit/retire, no
   * search input, no approval or flow actions. History stays: it reads.
   */
  readOnly?: boolean
}) {
  // Mutating controls need both the permission and the drawer edit mode,
  // exactly like the Overview tab's editable gate.
  const canEditAccounts = canManage && !readOnly
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [accounts, setAccounts] = useState(initialAccounts)
  const [draft, setDraft] = useState<BankAccountDraft | null>(null)
  const [historyAccount, setHistoryAccount] = useState<BankAccountClient | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  // Bank saves and retires pin beside the panel until the next action AND
  // toast; a 409 refreshes the list behind the still-open draft (the stale
  // token is never adopted) so the next save cannot overwrite unseen work.
  const { busy, refusal, execute, refuse } = useAppAction()
  const perPage = 10
  const countries = useMemo(() => countryOptions(locale), [locale])
  const currencies = useMemo(() => currencyOptions(locale), [locale])

  const filtered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    if (!needle) return accounts
    return accounts.filter((account) => [account.bank_name, account.country, account.currency, account.account_last_four, ...Object.values(account.routing ?? {})]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)))
  }, [accounts, q])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)

  function edit(account: BankAccountClient) {
    const routing = (account.routing ?? {}) as Record<string, string>
    setDraft({
      id: String(account.id), bankName: account.bank_name ?? '', country: account.country ?? '',
      currency: account.currency ?? '',
      routingNumber: routing.routingNumber ?? routing.institution ?? '',
      branchNumber: routing.branchNumber ?? routing.transit ?? '',
      accountNumber: '', routingBase: routing, lastFour: account.account_last_four ?? '',
      updatedAt: account.updated_at ?? '',
    })
  }

  async function refreshAccounts() {
    const response = await fetch(`/api/parties/${partyId}`)
    if (!response.ok) return
    const next = await response.json()
    setAccounts(next.bankAccounts ?? [])
    router.refresh()
  }

  async function saveBankAccount() {
    if (!draft) return
    if (!draft.bankName.trim()) {
      refuse(t('bankAccountValidation.bankName'), t('bankAccountSaveFailed'))
      return
    }
    if (!draft.id && draft.accountNumber.trim().length < 4) {
      refuse(t('bankAccountValidation.accountNumber'), t('bankAccountSaveFailed'))
      return
    }
    if (draft.currency && !/^[A-Za-z]{3}$/.test(draft.currency)) {
      refuse(t('bankAccountValidation.currency'), t('bankAccountSaveFailed'))
      return
    }
    const routing = { ...draft.routingBase }
    delete routing.institution
    delete routing.transit
    delete routing.routingNumber
    delete routing.branchNumber
    if (draft.routingNumber.trim()) routing.routingNumber = draft.routingNumber.trim()
    if (draft.branchNumber.trim()) routing.branchNumber = draft.branchNumber.trim()
    let changeReason: string | undefined
    if (draft.id) {
      const reason = await promptDialog({
        title: tc('amendment.title'),
        label: tc('amendment.reason'),
        placeholder: tc('amendment.placeholder'),
        confirmLabel: tc('actions.save'),
      })
      if (!reason) return
      changeReason = reason
    }
    const body = {
      bankName: draft.bankName.trim(), country: draft.country.trim() || null,
      ...(multiCurrency ? { currency: draft.currency.trim().toUpperCase() || null } : {}), routing,
      ...(draft.accountNumber.trim() ? { accountNumber: draft.accountNumber.trim() } : {}),
      ...(draft.id ? { expectedUpdatedAt: draft.updatedAt, changeReason } : {}),
    }
    const savedId = draft.id
    const ok = await execute(
      () =>
        fetchAction(
          savedId
            ? `/api/parties/${partyId}/bank-accounts?accountId=${encodeURIComponent(savedId)}`
            : `/api/parties/${partyId}/bank-accounts`,
          {
            method: savedId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
      {
        fallbackMessage: t('bankAccountSaveFailed'),
        successMessage: t(savedId ? 'bankAccountUpdated' : 'bankAccountAdded'),
        onOk: () => {
          setDraft(null)
        },
        onRefused: (error) => {
          // A 409 reloads the list behind the still-open draft — the server
          // reason names the recovery, and the stale token is never adopted,
          // so the next save still cannot overwrite unseen work. (Truncated tokens
          // once 409ed every save; the route bodies are clean human sentences
          // now, safe to surface.)
          if (error.kind === 'conflict') void refreshAccounts()
        },
      },
    )
    if (ok) await refreshAccounts()
  }

  async function retire(account: Record<string, unknown>) {
    const reason = await promptDialog({
      title: tc('actions.retire'),
      label: tc('amendment.reason'),
      placeholder: tc('amendment.voidPlaceholder'),
      confirmLabel: tc('actions.retire'),
    })
    if (!reason) return
    const ok = await execute(
      () =>
        fetchAction(
          `/api/parties/${partyId}/bank-accounts?accountId=${encodeURIComponent(String(account.id))}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              retirementReason: reason,
              expectedUpdatedAt: account.updated_at,
            }),
          },
        ),
      {
        fallbackMessage: t('bankAccountSaveFailed'),
        successMessage: tc('actions.retire'),
        onRefused: (error) => {
          if (error.kind === 'conflict') void refreshAccounts()
        },
      },
    )
    if (ok) await refreshAccounts()
  }

  const statusLabel = (account: Record<string, unknown>) => {
    if (account.retired_at) return tc('status.retired')
    const status = String(account.approval_status ?? (account.approved_at ? 'approved' : 'pending'))
    if (status === 'approved') return tc('status.approved')
    if (status === 'rejected') return tc('status.rejected')
    return tc('status.pendingApproval')
  }

  // Bank accounts are issued against a persisted party: an unsaved-create
  // drawer passes an empty id, so the panel stays unmounted instead of
  // offering an Add flow whose first write can only 404.
  if (!partyId) return null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SublistHeading title={t('bankAccountsHeading')} description={t('bankAccountsDescription')} icon={<Landmark size={16} />} />
        {canEditAccounts ? <Button variant="outline" size="sm" onClick={() => setDraft(emptyBankDraft())}><Plus size={14} />{t('addBankAccount')}</Button> : null}
      </div>

      <Drawer
        open={draft !== null}
        onClose={() => { if (!busy) setDraft(null) }}
        stacked
        size="md"
        title={draft?.id ? t('editBankAccount') : t('addBankAccount')}
        description={t('bankAccountApprovalNote')}
        headerActions={<Badge variant="warning">{tc('status.pendingApproval')}</Badge>}
        footer={draft ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>{tc('actions.cancel')}</Button>
            <Button disabled={busy} onClick={saveBankAccount}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
          </>
        ) : undefined}
      >
        {draft ? (
          <>
          <ActionAlert error={refusal} fallbackMessage={t('bankAccountSaveFailed')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}><Label>{t('bankName')}</Label><Input value={draft.bankName} onChange={(event) => setDraft({ ...draft, bankName: event.target.value })} /></div>
            <div className={field}><Label>{t('country')}</Label><SearchSelect value={draft.country} onChange={(country) => setDraft({ ...draft, country })} options={countries} sheetTitle={t('country')} clearable ariaLabel={t('country')} /></div>
            {multiCurrency ? <div className={field}><Label>{tc('labels.currency')}</Label><Select value={draft.currency ?? ''} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>{!draft.currency && <option value="">—</option>}{currencies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></div> : null}
            <div className={field}><Label>{t('routingNumber')}</Label><Input className="font-mono" value={draft.routingNumber} onChange={(event) => setDraft({ ...draft, routingNumber: event.target.value })} /></div>
            <div className={field}><Label>{t('branchNumber')}</Label><Input className="font-mono" value={draft.branchNumber} onChange={(event) => setDraft({ ...draft, branchNumber: event.target.value })} /></div>
            <div className={field}>
              <Label>{t('accountNumber')}</Label>
              <Input type="password" autoComplete="off" className="font-mono" value={draft.accountNumber} onChange={(event) => setDraft({ ...draft, accountNumber: event.target.value })} placeholder={draft.id ? t('accountNumberUnchanged', { lastFour: draft.lastFour }) : undefined} />
            </div>
          </div>
          </>
        ) : null}
      </Drawer>

      <Drawer
        open={historyAccount !== null}
        onClose={() => setHistoryAccount(null)}
        stacked
        size="md"
        title={tc('approvalFlow.historyTitle')}
        description={historyAccount?.bank_name ?? t('bankAccountFallback')}
      >
        {historyAccount ? (
          <ApprovalHistory
            subjectKind="party_bank_account"
            subjectId={String(historyAccount.id)}
            showEmptyState
          />
        ) : null}
      </Drawer>

      <ActionAlert error={refusal} fallbackMessage={t('bankAccountSaveFailed')} />

      {accounts.length === 0 ? (
        <SublistEmpty icon={<Landmark size={22} />} text={t('noBankAccounts')} />
      ) : (
        <>
          {!readOnly ? (
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
            <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={t('bankAccountSearch')} className="pl-8" />
          </div>
          ) : null}
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('bankName')}</TableHead><TableHead>{t('routing')}</TableHead>
              <TableHead>{t('accountNumber')}</TableHead><TableHead>{tc('labels.currency')}</TableHead>
              <TableHead>{tc('labels.status')}</TableHead><TableHead className="text-right">{tc('labels.actions')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {shown.map((account) => (
                <TableRow key={String(account.id)}>
                  <TableCell className="font-medium">{account.bank_name || t('bankAccountFallback')}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{Object.values(account.routing ?? {}).filter(Boolean).join(' · ') || '—'}</TableCell>
                  <TableCell className="font-mono">•••• {account.account_last_four || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{account.currency || '—'}</TableCell>
                  <TableCell><Badge variant={account.retired_at ? 'outline' : account.approval_status === 'approved' || account.approved_at ? 'success' : account.approval_status === 'rejected' ? 'outline' : 'warning'}>{statusLabel(account)}</Badge></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {canEditAccounts ? <FlowManualButtons subjectKind="party_bank_account" subjectId={String(account.id)} /> : null}
                      {canEditAccounts ? (
                      <ApprovalActions
                        subjectKind="party_bank_account"
                        subjectId={String(account.id)}
                        submitApprovalHref={
                          canManage
                            ? `/api/parties/${partyId}/bank-accounts/submit?accountId=${encodeURIComponent(String(account.id))}`
                            : undefined
                        }
                      />
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => setHistoryAccount(account)}>
                        {tc('approvalFlow.historyTitle')}
                      </Button>
                      {canEditAccounts && !account.retired_at ? <Button variant="ghost" size="sm" onClick={() => edit(account)}>{tc('actions.edit')}</Button> : null}
                      {canEditAccounts && !account.retired_at ? <Button variant="ghost" size="sm" onClick={() => retire(account)}>{tc('actions.retire')}</Button> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
            <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
          </div>
        </>
      )}
    </section>
  )
}

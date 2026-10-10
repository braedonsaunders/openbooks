'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { FilePenLine } from 'lucide-react'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { Badge, Button, Drawer, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { field } from './party-drawer-model'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError, SublistLoading, SublistPager, useSublistRows } from '../../../components/drawer-sublist'

const MANDATE_SCHEMES = ['nacha', 'sepa_core', 'sepa_b2b', 'custom'] as const
const MANDATE_STATUSES = ['pending', 'active', 'suspended', 'revoked', 'expired'] as const
type MandateScheme = (typeof MANDATE_SCHEMES)[number]
type MandateStatus = (typeof MANDATE_STATUSES)[number]

interface MandateRow {
  id: string
  mandateReference: string
  scheme: MandateScheme
  status: MandateStatus
  partyBankAccountId: string
  bankAccountLabel: string
  signedOn: string | null
  validFrom: string | null
  expiresOn: string | null
}

interface BankAccountOption {
  id: string
  label: string
}

interface MandateDraft {
  id: string | null
  partyBankAccountId: string
  bankAccountLabel: string
  scheme: MandateScheme
  mandateReference: string
  status: MandateStatus
  signedOn: string
  validFrom: string
  expiresOn: string
}

const newDraft = (): MandateDraft => ({
  id: null,
  partyBankAccountId: '',
  bankAccountLabel: '',
  scheme: 'nacha',
  mandateReference: '',
  status: 'pending',
  signedOn: '',
  validFrom: '',
  expiresOn: '',
})

const draftFromRow = (row: MandateRow): MandateDraft => ({
  id: row.id,
  partyBankAccountId: row.partyBankAccountId,
  bankAccountLabel: row.bankAccountLabel,
  scheme: row.scheme,
  mandateReference: row.mandateReference,
  status: row.status,
  signedOn: row.signedOn ?? '',
  validFrom: row.validFrom ?? '',
  expiresOn: row.expiresOn ?? '',
})

/**
 * The write body for a mandate draft. A new mandate is always issued to the
 * drawer's own party; an existing one sends only the fields the mandate
 * route accepts after creation (scheme, reference and bank account are
 * fixed once recorded). Blank dates clear on update and are omitted on
 * create.
 */
function mandateWriteBody(partyId: string, draft: MandateDraft): Record<string, string> {
  if (draft.id) {
    return {
      status: draft.status,
      signedOn: draft.signedOn,
      validFrom: draft.validFrom,
      expiresOn: draft.expiresOn,
    }
  }
  return {
    partyId,
    partyBankAccountId: draft.partyBankAccountId,
    scheme: draft.scheme,
    mandateReference: draft.mandateReference.trim(),
    status: draft.status,
    ...(draft.signedOn ? { signedOn: draft.signedOn } : {}),
    ...(draft.validFrom ? { validFrom: draft.validFrom } : {}),
    ...(draft.expiresOn ? { expiresOn: draft.expiresOn } : {}),
  }
}

/** Scheme names are rail standards, spelled the same in every language; only
 *  the custom scheme carries a translated label. */
const SCHEME_NAMES: Record<Exclude<MandateScheme, 'custom'>, string> = {
  nacha: 'NACHA',
  sepa_core: 'SEPA Core',
  sepa_b2b: 'SEPA B2B',
}

const statusVariant = (status: MandateStatus): 'success' | 'destructive' | 'secondary' =>
  status === 'active' ? 'success' : status === 'revoked' ? 'destructive' : 'secondary'

/**
 * Direct-debit mandates on a customer record. Rows and the selectable bank
 * accounts come from the party's own mandate read; writes ride the
 * payment-operations mandate routes, which re-check the grant, the party's
 * subsidiary scope and the bank account's approval on every request.
 */
export function PartyDebitMandatesPanel({ partyId }: { partyId: string }) {
  const t = useTranslations('parties.drawer.debitMandates')
  const tc = useTranslations('common')
  const format = useFormatter()
  const { busy, refusal, execute, refuse, clearRefusal } = useAppAction()
  const [data, setData] = useState<{ mandates: MandateRow[]; bankAccounts: BankAccountOption[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<MandateDraft | null>(null)
  const [statusFilter, setStatusFilter] = useState<MandateStatus | ''>('')
  const mandates = useMemo(
    () => (data?.mandates ?? []).filter((mandate) => !statusFilter || mandate.status === statusFilter),
    [data, statusFilter],
  )
  const mandateText = useCallback((mandate: MandateRow) => `${mandate.mandateReference} ${mandate.bankAccountLabel}`, [])
  const list = useSublistRows(mandates, mandateText)

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/parties/${encodeURIComponent(partyId)}/debit-mandates`, { signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' && body.error.trim() ? body.error : t('loadFailed'))
    }
    const body = await response.json() as { mandates?: MandateRow[]; bankAccounts?: BankAccountOption[] }
    return { mandates: body.mandates ?? [], bankAccounts: body.bankAccounts ?? [] }
  }, [partyId, t])

  const applyLoaded = useCallback((loaded: { mandates: MandateRow[]; bankAccounts: BankAccountOption[] }) => {
    setData(loaded)
    setLoadError(null)
  }, [])

  const applyLoadFailure = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    setLoadError(error instanceof Error ? error.message : t('loadFailed'))
    setData(null)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(applyLoaded, applyLoadFailure)
    return () => controller.abort()
  }, [reload, applyLoaded, applyLoadFailure])

  function refresh(): void {
    void reload().then(applyLoaded, applyLoadFailure)
  }

  function open(next: MandateDraft) {
    clearRefusal()
    setDraft(next)
  }

  async function save() {
    if (!draft) return
    if (!draft.id && !draft.partyBankAccountId) {
      refuse(t('validation.bankAccount'), t('saveFailed'))
      return
    }
    if (!draft.id && !draft.mandateReference.trim()) {
      refuse(t('validation.reference'), t('saveFailed'))
      return
    }
    const ok = await execute(
      () => fetchAction(
        draft.id
          ? `/api/admin/payment-operations/mandates/${encodeURIComponent(draft.id)}`
          : '/api/admin/payment-operations/mandates',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mandateWriteBody(partyId, draft)),
        },
      ),
      {
        fallbackMessage: t('saveFailed'),
        successMessage: t('saved'),
        onOk: () => setDraft(null),
      },
    )
    if (ok) refresh()
  }

  const schemeLabel = (scheme: MandateScheme) => scheme === 'custom' ? t('schemes.custom') : SCHEME_NAMES[scheme]
  const formatDate = (value: string | null) => value
    ? format.dateTime(new Date(`${value}T12:00:00Z`), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '—'

  // Mandates are issued against a persisted party; an unsaved-create drawer
  // passes an empty id, so the panel stays unmounted.
  if (!partyId) return null

  const bankAccounts = data?.bankAccounts ?? []
  const creating = draft !== null && draft.id === null

  return (
    <DrawerSublist
      title={t('heading')}
      description={t('description')}
      icon={<FilePenLine size={16} />}
      action={data ? <SublistAddButton label={t('new')} onClick={() => open(newDraft())} /> : undefined}
      alert={draft === null ? <ActionAlert error={refusal} fallbackMessage={t('saveFailed')} /> : null}
      search={data?.mandates.length ? { value: list.query, onChange: list.setQuery, placeholder: t('search') } : undefined}
      filters={data?.mandates.length ? (
        <Select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as MandateStatus | ''); list.setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.status')}>
          <option value="">{t('allStatuses')}</option>
          {MANDATE_STATUSES.map((status) => <option key={status} value={status}>{t(`states.${status}`)}</option>)}
        </Select>
      ) : null}
      footer={data?.mandates.length ? <SublistPager page={list.page} pages={list.pages} onPage={list.setPage} /> : null}
    >

      <Drawer
        open={draft !== null}
        onClose={() => { if (!busy) setDraft(null) }}
        stacked
        size="md"
        title={creating ? t('newTitle') : t('editTitle')}
        description={t('drawerDescription')}
        footer={draft ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>{tc('actions.cancel')}</Button>
            <Button disabled={busy} onClick={() => void save()}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
          </>
        ) : undefined}
      >
        {draft ? (
          <div className="space-y-4">
            <ActionAlert error={refusal} fallbackMessage={t('saveFailed')} />
            <div className={field}>
              <Label htmlFor="debit-mandate-bank-account">{creating ? t('fields.bankAccount') : t('columns.bankAccount')}</Label>
              {creating ? (
                <Select
                  id="debit-mandate-bank-account"
                  value={draft.partyBankAccountId}
                  onChange={(event) => setDraft({ ...draft, partyBankAccountId: event.target.value })}
                >
                  <option value="">{t('select')}</option>
                  {bankAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.label}</option>
                  ))}
                </Select>
              ) : (
                <Input id="debit-mandate-bank-account" disabled value={draft.bankAccountLabel} />
              )}
              {creating && bankAccounts.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t.rich('noApprovedAccounts', {
                    link: (chunks) => (
                      <Link
                        href={`/parties?party=${encodeURIComponent(partyId)}&partyTab=accounting`}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={field}>
                <Label htmlFor="debit-mandate-scheme">{t('fields.scheme')}</Label>
                <Select
                  id="debit-mandate-scheme"
                  disabled={!creating}
                  value={draft.scheme}
                  onChange={(event) => setDraft({ ...draft, scheme: event.target.value as MandateScheme })}
                >
                  {MANDATE_SCHEMES.map((scheme) => <option key={scheme} value={scheme}>{schemeLabel(scheme)}</option>)}
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="debit-mandate-reference">{t('fields.reference')}</Label>
                <Input
                  id="debit-mandate-reference"
                  className="font-mono"
                  disabled={!creating}
                  value={draft.mandateReference}
                  onChange={(event) => setDraft({ ...draft, mandateReference: event.target.value })}
                />
              </div>
            </div>
            {!creating ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('lockedNote')}</p> : null}
            <div className={field}>
              <Label htmlFor="debit-mandate-status">{tc('labels.status')}</Label>
              <Select
                id="debit-mandate-status"
                value={draft.status}
                onChange={(event) => setDraft({ ...draft, status: event.target.value as MandateStatus })}
              >
                {MANDATE_STATUSES.map((status) => <option key={status} value={status}>{t(`states.${status}`)}</option>)}
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className={field}>
                <Label htmlFor="debit-mandate-signed-on">{t('fields.signedOn')}</Label>
                <Input id="debit-mandate-signed-on" type="date" value={draft.signedOn} onChange={(event) => setDraft({ ...draft, signedOn: event.target.value })} />
              </div>
              <div className={field}>
                <Label htmlFor="debit-mandate-valid-from">{t('fields.validFrom')}</Label>
                <Input id="debit-mandate-valid-from" type="date" value={draft.validFrom} onChange={(event) => setDraft({ ...draft, validFrom: event.target.value })} />
              </div>
              <div className={field}>
                <Label htmlFor="debit-mandate-expires-on">{t('fields.expiresOn')}</Label>
                <Input id="debit-mandate-expires-on" type="date" value={draft.expiresOn} onChange={(event) => setDraft({ ...draft, expiresOn: event.target.value })} />
              </div>
            </div>
          </div>
        ) : null}
      </Drawer>

      {data === null ? (
        loadError ? <SublistLoadError message={loadError} onRetry={refresh} /> : <SublistLoading />
      ) : data.mandates.length === 0 ? (
        <SublistEmpty icon={<FilePenLine size={22} />} text={t('empty')} />
      ) : list.shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{tc('feedback.noResults')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fields.reference')}</TableHead>
              <TableHead>{t('columns.bankAccount')}</TableHead>
              <TableHead>{t('fields.scheme')}</TableHead>
              <TableHead>{t('fields.signedOn')}</TableHead>
              <TableHead>{t('fields.expiresOn')}</TableHead>
              <TableHead>{tc('labels.status')}</TableHead>
              <TableHead className="text-right">{tc('labels.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.shown.map((mandate) => (
              <TableRow key={mandate.id}>
                <TableCell className="font-mono text-xs font-semibold">{mandate.mandateReference}</TableCell>
                <TableCell>{mandate.bankAccountLabel || '—'}</TableCell>
                <TableCell>{schemeLabel(mandate.scheme)}</TableCell>
                <TableCell className="tabular-nums">{formatDate(mandate.signedOn)}</TableCell>
                <TableCell className="tabular-nums">{formatDate(mandate.expiresOn)}</TableCell>
                <TableCell><Badge variant={statusVariant(mandate.status)}>{t(`states.${mandate.status}`)}</Badge></TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => open(draftFromRow(mandate))}>{tc('actions.edit')}</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DrawerSublist>
  )
}

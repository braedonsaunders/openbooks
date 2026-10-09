'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, PageHeader, Select } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { PagedTable } from '@/components/paged-table'
import { AsyncUrlDrawer } from '@/components/async-url-drawer'
import { useMoney } from '@/components/money-provider'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import { DocTypeBadge } from '@/components/doc-type-badge'
import { readApiErrorMessage } from '@/lib/api-error'
import type { WithholdingPeriodSummary, WithholdingReturnView, WithholdingStatement } from '@openbooks/engine/contractor-withholding'
import type { WithholdingEnrollmentOption } from '@/lib/contractor-withholding'

type DepositRow = { documentId: string; documentNumber: string; kind: string; status: string; throughDate: string; dueDate: string | null; currency: string; total: string; sourceChanged: boolean }
type StandingRow = { id: string; entityName: string | null; partyName: string; schemeCode: string; bandCode: string; status: string; validFrom: string; validTo: string | null }
type ReturnPayload = { return: WithholdingReturnView; statements: WithholdingStatement[] }
async function read<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options })
  if (!response.ok) throw new Error(await readApiErrorMessage(response, 'Request failed'))
  return await response.json() as T
}
export function WithholdingWorkspace({ enrollments, canManage, canReadJournal, canSetup, canStandings, standings }: { enrollments: WithholdingEnrollmentOption[]; canManage: boolean; canReadJournal: boolean; canSetup: boolean; canStandings: boolean; standings: StandingRow[] }) {
  const t = useTranslations('ap.withholding')
  const tc = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { money } = useMoney()
  const selected = params.get('enrollment') || enrollments[0]?.id || ''
  const enrollment = enrollments.find(row => row.id === selected)
  const returnId = params.get('return')
  const tab = params.get('tab') === 'standings' && canStandings ? 'standings' : params.get('tab') === 'deposits' && enrollment?.canDeposit ? 'deposits' : 'periods'
  const [deposits, setDeposits] = useState<DepositRow[]>([])
  const [depositsLoadedFor, setDepositsLoadedFor] = useState('')
  const [periods, setPeriods] = useState<WithholdingPeriodSummary[]>([])
  const [loadedFor, setLoadedFor] = useState('')
  const [payload, setPayload] = useState<ReturnPayload | null>(null)
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [periodStart, setPeriodStart] = useState('')
  const [depositThrough, setDepositThrough] = useState('')
  const [filingReference, setFilingReference] = useState('')
  const [statementIndex, setStatementIndex] = useState(-1)
  const [returnBody, setReturnBody] = useState<'payees' | 'payments'>('payees')
  const currentReturn = payload?.return.id === returnId ? payload : null
  function href(values: Record<string, string | null>) { const query = new URLSearchParams(params.toString()); for (const [key, value] of Object.entries(values)) value ? query.set(key, value) : query.delete(key); return `${pathname}${query.size ? `?${query}` : ''}` }
  function authorityHref(id: string, kind: unknown) { return kind === 'journal' ? `/journal?entry=${encodeURIComponent(id)}` : `/ap/bills?doc=${encodeURIComponent(id)}` }
  function openAuthority(data: Record<string, unknown>) {
    if (data.kind === 'journal' && !canReadJournal) { setNotice(t('journalPreparedForReview', { number: String(data.documentNumber ?? '') })); return }
    router.push(authorityHref(String(data.documentId), data.kind))
  }
  function navigate(values: Record<string, string | null>) { router.push(href(values), { scroll: false }) }
  useEffect(() => {
    if (!selected || tab !== 'periods') return
    const abort = new AbortController()
    read<{ periods: WithholdingPeriodSummary[] }>(`/api/contractor-withholding/periods?enrollmentId=${encodeURIComponent(selected)}`, { signal: abort.signal })
      .then(data => { if (abort.signal.aborted) return; setPeriods(data.periods); setLoadedFor(selected); setFailures(previous => { const next = { ...previous }; delete next[selected]; return next }) })
      .catch(error => { if (!abort.signal.aborted) setFailures(previous => ({ ...previous, [selected]: String(error.message) })) })
    return () => abort.abort()
  }, [selected, tab, retry])
  useEffect(() => {
    if (!selected || tab !== 'deposits') return
    const abort = new AbortController()
    read<{ deposits: DepositRow[] }>(`/api/contractor-withholding/deposits?enrollmentId=${encodeURIComponent(selected)}`, { signal: abort.signal })
      .then(data => { if (abort.signal.aborted) return; setDeposits(data.deposits); setDepositsLoadedFor(selected); setFailures(previous => { const next = { ...previous }; delete next['deposits:' + selected]; return next }) })
      .catch(error => { if (!abort.signal.aborted) setFailures(previous => ({ ...previous, ['deposits:' + selected]: String(error.message) })) })
    return () => abort.abort()
  }, [selected, tab, retry])
  useEffect(() => {
    if (!returnId) return
    const abort = new AbortController()
    read<ReturnPayload>(`/api/contractor-withholding/returns/${encodeURIComponent(returnId)}`, { signal: abort.signal })
      .then(data => { if (abort.signal.aborted) return; setPayload(data); setFilingReference(data.return.sourceOnlyRevision ? data.return.priorFilingReference ?? '' : data.return.filingReference ?? ''); setReturnBody(data.return.sourceOnlyRevision ? 'payments' : 'payees'); setStatementIndex(-1); setFailures(previous => { const next = { ...previous }; delete next[returnId]; return next }) })
      .catch(error => { if (!abort.signal.aborted) setFailures(previous => ({ ...previous, [returnId]: String(error.message) })) })
    return () => abort.abort()
  }, [returnId, retry])
  async function action(url: string, body: unknown, onSuccess?: (data: Record<string, unknown>) => void) {
    setBusy(true); setRefusal(null); setNotice(null)
    try { const data = await read<Record<string, unknown>>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); onSuccess?.(data); setRetry(value => value + 1); router.refresh() }
    catch (error) { setRefusal(error instanceof Error ? error.message : t('failed')) }
    finally { setBusy(false) }
  }
  async function prepare(start: string) { await action('/api/contractor-withholding/returns', { enrollmentId: selected, periodStart: start }, data => navigate({ return: String(data.id) })) }
  const ret = currentReturn?.return
  const statement = statementIndex >= 0 ? currentReturn?.statements[statementIndex] : null
  const currency = enrollment?.currency ?? ''
  const workpaper = ret?.returnKind === 'financial_workpaper'
  async function recordReturn() {
    if (workpaper && !await confirmDialog({ message: t('reviewConfirmation'), confirmLabel: t('review'), tone: 'default' })) return
    await action(`/api/contractor-withholding/returns/${ret!.id}`, { action: 'file', filingReference, ...(workpaper || ret?.sourceOnlyRevision ? { confirmed: true } : {}) })
  }
  return <ListPageLayout header={<>
    <PageHeader title={t('title')} description={t('description')} actions={canSetup ? <Button asChild variant="outline"><Link href="/admin/setup/withholding-enrollments">{t('enrollments')}</Link></Button> : undefined} />
    <div className="flex gap-2"><Button variant={tab === 'periods' ? 'secondary' : 'ghost'} onClick={() => navigate({ tab: null, return: null })}>{t('periods')}</Button>{enrollment?.canDeposit && <Button variant={tab === 'deposits' ? 'secondary' : 'ghost'} onClick={() => navigate({ tab: 'deposits', return: null })}>{t('deposits')}</Button>}{canStandings && <Button variant={tab === 'standings' ? 'secondary' : 'ghost'} onClick={() => navigate({ tab: 'standings', return: null })}>{t('standings')}</Button>}</div>
    {tab !== 'standings' && <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-64"><Label>{t('enrollment')}</Label><Select value={selected} onChange={event => navigate({ enrollment: event.target.value, return: null })}><option value="">{t('selectEnrollment')}</option>{enrollments.map(row => <option value={row.id} key={row.id}>{row.entityName} · {row.schemeName} · {row.contractorReference}</option>)}</Select></div>
      {canManage && tab === 'deposits' && enrollment?.canDeposit && <><div><Label>{t('depositThrough')}</Label><Input type="date" value={depositThrough} onChange={event => setDepositThrough(event.target.value)} /></div><Button variant="outline" disabled={busy || !depositThrough} onClick={() => action('/api/contractor-withholding/deposits', { enrollmentId: selected, throughDate: depositThrough }, openAuthority)}>{t('deposit')}</Button></>}
      {canManage && tab === 'periods' && selected && <><div><Label>{t('periodStart')}</Label><Input type="date" value={periodStart} onChange={event => setPeriodStart(event.target.value)} /></div><Button disabled={busy || !periodStart} onClick={() => prepare(periodStart)}>{t('prepare')}</Button></>}
    </div>}
    {enrollment?.filingNotice && tab === 'periods' && <p className="text-sm text-muted-foreground">{enrollment.filingNotice}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {refusal && <p role="alert" className="text-sm text-red-600">{refusal}</p>}
  </>}>
    {tab === 'standings' ? <PagedTable source="contractor_withholding_standings" rows={standings} rowKey={row => row.id} searchable empty={t('emptyStandings')} toolbarAfter={<Button asChild><Link href="/admin/setup/withholding-standings?row=new">{tc('actions.create')}</Link></Button>} columns={[
      { key: 'entity', header: t('legalEntity'), cell: row => row.entityName ?? t('unassignedEntity'), search: row => row.entityName ?? '' },
      { key: 'vendor', header: t('payee'), cell: row => <Link href={`/admin/setup/withholding-standings?row=${row.id}`}>{row.partyName}</Link>, search: row => row.partyName },
      { key: 'scheme', header: t('scheme'), cell: row => row.schemeCode },
      { key: 'band', header: t('band'), cell: row => row.bandCode },
      { key: 'date', header: t('validFrom'), cell: row => row.validFrom },
      { key: 'status', header: t('status'), cell: row => <Badge>{row.status}</Badge> },
      { key: 'actions', header: '', cell: row => row.status === 'active' ? <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { const reason = await promptDialog({ title: t('revoke'), label: t('reason') }); if (reason) await action(`/api/contractor-withholding/standings/${row.id}`, { reason }) }}>{t('revoke')}</Button> : null },
    ]} /> : tab === 'deposits' ? !selected ? <p className="text-sm text-muted-foreground">{t('emptyEnrollments')}</p> : failures['deposits:' + selected] ? <div role="alert"><p>{failures['deposits:' + selected]}</p><Button onClick={() => setRetry(value => value + 1)}>{tc('actions.retry')}</Button></div> : depositsLoadedFor !== selected ? <p aria-busy="true">{tc('actions.loading')}</p> : <PagedTable source="contractor_withholding_deposits" rows={deposits} rowKey={row => row.documentId} empty={t('emptyDeposits')} columns={[
      { key: 'document', header: t('depositDocument'), cell: row => row.kind === 'journal' && !canReadJournal ? <span title={t('journalReviewAccess')}>{row.documentNumber}</span> : <Link href={authorityHref(row.documentId, row.kind)}>{row.documentNumber}</Link> },
      { key: 'kind', header: tc('labels.type'), cell: row => <DocTypeBadge kind={row.kind} /> },
      { key: 'through', header: t('depositThrough'), cell: row => row.throughDate },
      { key: 'due', header: t('paymentDue'), cell: row => row.dueDate ?? '—' },
      { key: 'total', header: t('deducted'), align: 'right', cell: row => money(row.total, { currency: row.currency }) },
      { key: 'status', header: t('status'), cell: row => <Badge>{row.sourceChanged ? t('changed') : tc(`status.${row.status}`)}</Badge> },
      { key: 'action', header: '', cell: row => canManage && row.status === 'posted' && row.sourceChanged ? <Button variant="outline" size="sm" disabled={busy} onClick={() => action('/api/contractor-withholding/deposits', { enrollmentId: selected, throughDate: row.throughDate, amendsDocumentId: row.documentId }, openAuthority)}>{t('correctDeposit')}</Button> : null },
    ]} /> : !selected ? <p className="text-sm text-muted-foreground">{t('emptyEnrollments')}</p> : failures[selected] ? <div role="alert"><p>{failures[selected]}</p><Button onClick={() => setRetry(value => value + 1)}>{tc('actions.retry')}</Button></div> : loadedFor !== selected ? <p aria-busy="true">{tc('actions.loading')}</p> : <PagedTable source="contractor_withholding_periods" rows={periods} rowKey={row => row.periodStart} empty={t('emptyPeriods')} columns={[
      { key: 'period', header: t('period'), cell: row => <span>{row.periodStart} – {row.periodEnd}</span> },
      { key: 'deducted', header: t('deducted'), align: 'right', cell: row => money(row.deducted, { currency }) },
      { key: 'due', header: t('returnDue'), cell: row => row.returnDue ?? '—' },
      { key: 'payment', header: t('paymentDue'), cell: row => row.paymentDue ?? '—' },
      { key: 'status', header: t('status'), cell: row => <span>{row.changedSinceFiled ? t('changed') : row.latestReturn ? (enrollment?.returnKind === 'financial_workpaper' && row.latestReturn.status === 'filed' ? t('reviewed') : t(`statuses.${row.latestReturn.status}`)) : t('unprepared')}</span> },
      { key: 'action', header: '', cell: row => <div className="flex gap-2">{row.latestReturn && <Button variant="outline" size="sm" onClick={() => navigate({ return: row.latestReturn!.id })}>{tc('actions.open')}</Button>}{canManage && <Button variant="ghost" size="sm" disabled={busy} onClick={() => prepare(row.periodStart)}>{t('prepare')}</Button>}</div> },
    ]} />}
    {returnId && <AsyncUrlDrawer open openKey={returnId} pending={!currentReturn} error={failures[returnId] ?? null} onRetry={() => setRetry(value => value + 1)} beforeClose={async () => !ret || ret.status !== 'prepared' || filingReference === (ret.filingReference ?? '') || confirmDialog({ message: tc('feedback.unsavedChanges'), confirmLabel: tc('confirm.discardChanges'), tone: 'danger' })} closeHref={href({ return: null })} title={ret ? `${ret.schemeName} · ${ret.periodStart}` : t('return')} size="2xl">
      {ret && <div className="space-y-5">
        <div className="flex flex-wrap gap-2"><Badge>{(workpaper || ret.sourceOnlyRevision) && ret.status === 'filed' ? t('reviewed') : t(`statuses.${ret.status}`)}</Badge><span>{ret.entityName} · {ret.contractorReference}</span><span>{t('revision', { revision: ret.revision })}</span></div>
        <div className="flex flex-wrap gap-3"><span>{t('deducted')}: {money(ret.totals.deducted, { currency: ret.currency })}</span><span>{t('returnDue')}: {ret.returnDue ?? '—'}</span><span>{t('paymentDue')}: {ret.paymentDue ?? '—'}</span></div>
        <div className="flex flex-wrap items-end gap-2"><Button variant="outline" asChild><a href={`/api/contractor-withholding/returns/${ret.id}?format=csv`}>{t('export')}</a></Button>
          {canManage && ret.status === 'prepared' && <><div><Label>{t(workpaper ? 'reviewReference' : 'filingReference')}</Label><Input value={filingReference} readOnly={ret.sourceOnlyRevision} onChange={event => setFilingReference(event.target.value)} /></div><Button disabled={busy || !filingReference.trim()} onClick={recordReturn}>{t(ret.sourceOnlyRevision ? 'reviewSourceCorrection' : workpaper ? 'review' : 'file')}</Button></>}
          {canManage && ret.status === 'filed' && !ret.remittanceDocumentId && !enrollment?.canDeposit && <Button disabled={busy} onClick={() => action(`/api/contractor-withholding/returns/${ret.id}`, { action: 'remit' }, openAuthority)}>{t('remit')}</Button>}
          {ret.remittanceDocumentId && ret.remittanceDocumentKind === 'journal' && !canReadJournal && <p role="status" className="text-sm text-muted-foreground">{t('journalReviewAccess')}</p>}
          {ret.remittanceDocumentId && (ret.remittanceDocumentKind !== 'journal' || canReadJournal) && <Button variant="outline" asChild><Link href={authorityHref(ret.remittanceDocumentId, ret.remittanceDocumentKind)}>{t('openRemittance')}</Link></Button>}
        </div>
        {ret.sourceOnlyRevision && <p className="text-sm text-muted-foreground">{t('sourceOnlyCorrectionHelp')}</p>}
        {refusal && <p role="alert" className="text-sm text-red-600">{refusal}</p>}
        <div><Button variant="outline" asChild><a href={`/api/contractor-withholding/returns/${ret.id}?format=pdf${statementIndex >= 0 ? `&payee=${encodeURIComponent(ret.lines[statementIndex]?.partyId ?? '')}` : ''}`}>{t('downloadPdf')}</a></Button><Label>{t('statement')}</Label><Select value={String(statementIndex)} onChange={event => setStatementIndex(Number(event.target.value))}><option value="-1">{t('return')}</option>{(currentReturn?.statements ?? []).map((row, index) => <option key={index} value={index}>{row.payeeName}</option>)}</Select></div>
        {!!ret.sourcePayments?.length && <div className="flex gap-2"><Button variant={returnBody === 'payees' ? 'secondary' : 'ghost'} onClick={() => setReturnBody('payees')}>{t('payees')}</Button><Button variant={returnBody === 'payments' ? 'secondary' : 'ghost'} onClick={() => setReturnBody('payments')}>{t('paymentEvidence')}</Button></div>}
        {returnBody === 'payments' ? <PagedTable source="contractor_withholding_return_payments" rows={ret.sourcePayments ?? []} rowKey={row => row.documentId} empty={t('emptySourcePayments')} columns={[
          { key: 'payment', header: t('paymentDocument'), cell: row => <Link href={`/payments?doc=${row.documentId}`}>{row.documentNumber}</Link> },
          { key: 'date', header: tc('labels.date'), cell: row => row.paymentDate },
          { key: 'deducted', header: t('deducted'), align: 'right', cell: row => money(row.withholdingAmount, { currency: row.currency }) },
          { key: 'statutory', header: t('reportedDeduction'), align: 'right', cell: row => money(row.statutoryWithholdingAmount, { currency: row.statutoryCurrency }) },
          { key: 'fx', header: t('reportingFxRate'), align: 'right', cell: row => row.reportingFxRate ? `${row.currency} → ${row.statutoryCurrency} · ${row.reportingFxRate}` : '—' },
        ]} /> : statement ? <div className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">{t('statement')} · {statement.payeeName}</h3><p>{statement.contractorName} · {statement.contractorReferenceLabel}: {statement.contractorReference}</p><p>{statement.periodStart} – {statement.periodEnd}</p><p>{statement.payeeReferenceLabel}: {statement.payeeReference ?? '—'}</p><p>{statement.verificationLabel}: {statement.verificationReference ?? '—'}</p><dl className="grid grid-cols-2 gap-2">{(['paid', 'net', 'materials', 'base', 'deducted'] as const).map(key => <div key={key}><dt className="text-sm text-muted-foreground">{t(key)}</dt><dd>{money(statement[key], { currency: statement.currency })}</dd></div>)}</dl></div> : <PagedTable source="contractor_withholding_return_payees" rows={ret.lines} rowKey={row => row.partyId} empty={t('emptyPayees')} columns={[
          { key: 'payee', header: t('payee'), cell: row => row.payeeName },
          { key: 'waived', header: t('waived'), cell: row => money(row.waived ?? '0', { currency: ret.currency }) },
          { key: 'ref', header: ret.payeeReferenceLabel, cell: row => row.payeeReference ?? '—' },
          { key: 'paid', header: t('paid'), align: 'right', cell: row => money(row.paid, { currency: ret.currency }) },
          { key: 'base', header: t('base'), align: 'right', cell: row => money(row.base, { currency: ret.currency }) },
          { key: 'deducted', header: t('deducted'), align: 'right', cell: row => money(row.deducted, { currency: ret.currency }) },
        ]} />}
      </div>}
    </AsyncUrlDrawer>}
  </ListPageLayout>
}

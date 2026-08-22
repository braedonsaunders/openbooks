'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { AttachmentPanel } from '../../../../components/attachment-panel'
import { promptDialog } from '../../../../lib/prompt'
import type { LienWaiverRow } from '../../../../lib/compliance'

/**
 * One lien waiver, and the transitions available from where it stands.
 *
 * Signing is separated from the rest and warned about, because an
 * unconditional waiver releases the subcontractor's lien rights whether or not
 * the money ever arrives. That is the single most consequential click in the
 * module and it should not look like the others.
 */
export function LienWaiverDrawer({
  waiver,
  openBills,
  closeHref,
  canManage,
}: {
  waiver: LienWaiverRow
  openBills: { id: string; label: string; amount: string; currency: string }[]
  closeHref: string
  canManage: boolean
}) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const today = useBusinessToday()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [sign, setSign] = useState({
    signedByName: waiver.signedByName ?? '',
    signedByTitle: waiver.signedByTitle ?? '',
    signedAt: waiver.signedAt?.slice(0, 10) ?? today,
    notarized: waiver.notarized,
  })
  const [edit, setEdit] = useState({
    throughDate: waiver.throughDate,
    amount: waiver.amount,
    jurisdiction: waiver.jurisdiction ?? '',
    notes: waiver.notes ?? '',
  })

  const editable = ['draft', 'requested', 'received'].includes(waiver.status)
  const isUnconditional = waiver.waiverType.startsWith('unconditional')

  async function act(body: Record<string, unknown>): Promise<void> {
    setError(null)
    const res = await fetch(`/api/compliance/lien-waivers/${waiver.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? t('errors.saveFailed'))
      return
    }
    startTransition(() => router.refresh())
  }

  async function reject() {
    const reason = await promptDialog({ title: t('lienWaivers.rejectTitle'), label: t('lienWaivers.rejectReason') })
    if (!reason) return
    await act({ action: 'reject', reason })
  }

  async function voidWaiver() {
    const reason = await promptDialog({ title: t('lienWaivers.voidTitle'), label: t('lienWaivers.voidReason') })
    if (!reason) return
    await act({ action: 'void', reason })
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={waiver.waiverNumber}
      description={`${waiver.partyName} · ${waiver.projectName}`}
      headerActions={
        <div className="flex items-center gap-2">
          <Badge variant={waiver.status === 'signed' ? 'success' : waiver.status === 'void' ? 'secondary' : 'warning'}>
            {t(`waiverStatus.${waiver.status}`)}
          </Badge>
          <Button asChild variant="ghost" size="sm">
            <a href={`/api/compliance/lien-waivers/${waiver.id}/pdf`} target="_blank" rel="noreferrer">
              {t('lienWaivers.printForm')}
            </a>
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <Alert className="mb-4" variant={isUnconditional ? 'destructive' : 'default'}>
        <AlertDescription>
          <strong className="mr-1">{t(`waiverType.${waiver.waiverType}`)}:</strong>
          {t(`waiverTypeHint.${waiver.waiverType}`)}
        </AlertDescription>
      </Alert>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {(
          [
            [t('lienWaivers.columns.direction'), t(`direction.${waiver.direction}`)],
            [t('lienWaivers.columns.through'), waiver.throughDate],
            [t('lienWaivers.columns.amount'), `${waiver.currency} ${waiver.amount}`],
            [t('lienWaivers.columns.jurisdiction'), waiver.jurisdiction ?? '—'],
            [t('lienWaivers.columns.bill'), waiver.billNumber ?? '—'],
            [t('lienWaivers.columns.requested'), waiver.requestedAt?.slice(0, 10) ?? '—'],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-slate-100 py-1.5 dark:border-slate-800">
            <dt className="text-sm text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="text-sm font-medium text-slate-800 dark:text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>

      {waiver.rejectedReason ? (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{waiver.rejectedReason}</p>
      ) : null}
      {waiver.voidReason ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{waiver.voidReason}</p>
      ) : null}

      {waiver.status === 'signed' ? (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
          {t('lienWaivers.signedBy', {
            who: waiver.signedByName ?? '—',
            title: waiver.signedByTitle ?? '',
            when: waiver.signedAt?.slice(0, 10) ?? '',
          })}
        </p>
      ) : null}

      {canManage && editable ? (
        <section className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-2">
            {waiver.status === 'draft' ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act({ action: 'request' })}>
                {t('lienWaivers.request')}
              </Button>
            ) : null}
            {waiver.status !== 'received' ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act({ action: 'receive' })}>
                {t('lienWaivers.receive')}
              </Button>
            ) : null}
            {waiver.status !== 'draft' ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={reject}>
                {t('lienWaivers.reject')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={pending} onClick={voidWaiver}>
              {t('lienWaivers.void')}
            </Button>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <h4 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t('lienWaivers.editTitle')}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>{t('lienWaivers.columns.through')}</Label>
                <Input
                  type="date"
                  value={edit.throughDate}
                  onChange={(event) => setEdit({ ...edit, throughDate: event.target.value })}
                />
              </div>
              <div>
                <Label>{t('lienWaivers.columns.amount')}</Label>
                <Input
                  inputMode="decimal"
                  className="text-right tabular-nums"
                  value={edit.amount}
                  onChange={(event) => setEdit({ ...edit, amount: event.target.value })}
                />
                {openBills.length > 0 ? (
                  <Select
                    className="mt-1"
                    value=""
                    onChange={(event) => {
                      const bill = openBills.find((b) => b.id === event.target.value)
                      if (bill) setEdit({ ...edit, amount: bill.amount })
                    }}
                  >
                    <option value="">{t('lienWaivers.copyFromBill')}</option>
                    {openBills.map((bill) => (
                      <option key={bill.id} value={bill.id}>
                        {bill.label} — {bill.currency} {bill.amount}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </div>
              <div>
                <Label>{t('lienWaivers.columns.jurisdiction')}</Label>
                <Input
                  value={edit.jurisdiction}
                  onChange={(event) => setEdit({ ...edit, jurisdiction: event.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Label>{t('fields.notes')}</Label>
                <Textarea
                  rows={2}
                  value={edit.notes}
                  onChange={(event) => setEdit({ ...edit, notes: event.target.value })}
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('lienWaivers.notesHint')}</p>
              </div>
              <div className="sm:col-span-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    act({
                      action: 'update',
                      throughDate: edit.throughDate,
                      amount: edit.amount,
                      jurisdiction: edit.jurisdiction || null,
                      notes: edit.notes || null,
                    })
                  }
                >
                  {t('fields.save')}
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 dark:border-teal-900/60 dark:bg-teal-950/20">
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t('lienWaivers.recordSignature')}
            </h4>
            <p className="mt-1 mb-3 text-xs text-slate-600 dark:text-slate-300">
              {t('lienWaivers.recordSignatureHint')}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>{t('lienWaivers.signedByName')}</Label>
                <Input
                  value={sign.signedByName}
                  onChange={(event) => setSign({ ...sign, signedByName: event.target.value })}
                />
              </div>
              <div>
                <Label>{t('lienWaivers.signedByTitle')}</Label>
                <Input
                  value={sign.signedByTitle}
                  onChange={(event) => setSign({ ...sign, signedByTitle: event.target.value })}
                />
              </div>
              <div>
                <Label>{t('lienWaivers.signedAt')}</Label>
                <Input
                  type="date"
                  value={sign.signedAt}
                  onChange={(event) => setSign({ ...sign, signedAt: event.target.value })}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input
                  type="checkbox"
                  checked={sign.notarized}
                  onChange={(event) => setSign({ ...sign, notarized: event.target.checked })}
                />
                <span className="text-sm">{t('lienWaivers.notarized')}</span>
              </div>
              <div className="sm:col-span-2">
                <Button
                  disabled={pending || !sign.signedByName.trim()}
                  onClick={() => act({ action: 'sign', ...sign })}
                >
                  {t('lienWaivers.markSigned')}
                </Button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-6 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h4 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t('lienWaivers.executedCopy')}
        </h4>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t('lienWaivers.executedCopyHint')}</p>
        <AttachmentPanel targetTable="lien_waivers" targetId={waiver.id} canEdit={canManage} />
      </section>
    </UrlDrawer>
  )
}

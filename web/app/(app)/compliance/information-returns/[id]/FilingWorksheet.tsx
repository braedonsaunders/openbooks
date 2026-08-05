'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@openbooks/ui'
import type { FormBox } from '@openbooks/engine/src/information-returns.ts'
import { promptDialog } from '../../../../../lib/prompt'
import type { FilingDetail, RecipientRow } from '../../../../../lib/compliance'

const FILING_CHANNELS = ['iris', 'fire', 'provider', 'paper', 'other'] as const

function amount(value: string | undefined): string {
  if (!value) return ''
  const n = Number(value)
  return Number.isFinite(n) && n !== 0
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : ''
}

function filed(recipient: RecipientRow, box: string): string {
  const computed = Number(recipient.computedAmounts[box] ?? 0)
  const adjustment = Number(recipient.adjustments[box] ?? 0)
  const total = computed + adjustment
  return total !== 0 ? total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''
}

/**
 * The recipient worksheet and the filing's lifecycle controls.
 *
 * Amounts show the FILED figure with the ledger figure beside it whenever a
 * person has adjusted it, because "why does this differ from the books" is the
 * first question anyone reviewing a 1099 asks.
 */
export function FilingWorksheet({
  filing,
  boxes,
  canManage,
  canFile,
}: {
  filing: FilingDetail
  boxes: FormBox[]
  canManage: boolean
  canFile: boolean
}) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<RecipientRow | null>(null)
  const [draft, setDraft] = useState<{ adjustments: Record<string, string>; reason: string; excluded: boolean; exclusionReason: string }>({
    adjustments: {},
    reason: '',
    excluded: false,
    exclusionReason: '',
  })
  const [fileOpen, setFileOpen] = useState(false)
  const [filingChannel, setFilingChannel] = useState<string>('iris')
  const [filingReference, setFilingReference] = useState('')

  const frozen = filing.status === 'finalized' || filing.status === 'filed' || filing.status === 'void'
  const amountBoxes = boxes.filter((box) => !box.isIndicator)

  async function post(body: Record<string, unknown>): Promise<unknown | null> {
    setError(null)
    setNotice(null)
    const res = await fetch(`/api/compliance/information-returns/${filing.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      setError(payload.error ?? t('errors.saveFailed'))
      return null
    }
    startTransition(() => router.refresh())
    return payload
  }

  async function compute() {
    const result = (await post({ action: 'compute' })) as
      | { recipients: number; tracedCash: string; exceptions: { kind: string; partyName: string; detail: string }[] }
      | null
    if (result) {
      setNotice(
        t('informationReturns.computed', {
          count: result.recipients,
          exceptions: result.exceptions.length,
        }),
      )
    }
  }

  async function voidFiling() {
    const reason = await promptDialog({
      title: t('informationReturns.voidTitle'),
      label: t('informationReturns.voidReason'),
    })
    if (!reason) return
    await post({ action: 'void', reason })
  }

  function openEditor(recipient: RecipientRow) {
    setDraft({
      adjustments: { ...recipient.adjustments },
      reason: recipient.adjustmentReason ?? '',
      excluded: recipient.status === 'excluded',
      exclusionReason: recipient.exclusionReason ?? '',
    })
    setEditing(recipient)
  }

  async function saveRecipient() {
    if (!editing) return
    setError(null)
    const res = await fetch(
      `/api/compliance/information-returns/${filing.id}/recipients/${editing.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          adjustments: draft.adjustments,
          adjustmentReason: draft.reason,
          status: draft.excluded ? 'excluded' : 'included',
          exclusionReason: draft.excluded ? draft.exclusionReason : null,
        }),
      },
    )
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? t('errors.saveFailed'))
      return
    }
    setEditing(null)
    startTransition(() => router.refresh())
  }

  const included = filing.recipients.filter((r) => r.status === 'included')

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={filing.status === 'filed' ? 'success' : frozen ? 'success' : 'warning'}>
          {t(`filingStatus.${filing.status}`)}
        </Badge>
        {canManage && !frozen ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={compute}>
            {filing.status === 'draft' ? t('informationReturns.compute') : t('informationReturns.recompute')}
          </Button>
        ) : null}
        {canFile && filing.status === 'computed' ? (
          <Button size="sm" disabled={pending} onClick={() => post({ action: 'finalize' })}>
            {t('informationReturns.finalize')}
          </Button>
        ) : null}
        {canFile && filing.status === 'finalized' ? (
          <Button size="sm" disabled={pending} onClick={() => setFileOpen(true)}>
            {t('informationReturns.markFiled')}
          </Button>
        ) : null}
        {included.length > 0 ? (
          <Button asChild size="sm" variant="ghost">
            <a href={`/api/compliance/information-returns/${filing.id}/copies`} target="_blank" rel="noreferrer">
              {t('informationReturns.printCopies')}
            </a>
          </Button>
        ) : null}
        {canFile && included.length > 0 ? (
          <Button asChild size="sm" variant="ghost">
            <a href={`/api/compliance/information-returns/${filing.id}/export`}>
              {t('informationReturns.exportTransmittal')}
            </a>
          </Button>
        ) : null}
        {canFile && filing.status !== 'void' ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={voidFiling}>
            {t('informationReturns.void')}
          </Button>
        ) : null}
        {filing.filingReference ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {t('informationReturns.filedVia', {
              channel: filing.filingChannel ?? '',
              reference: filing.filingReference,
            })}
          </span>
        ) : null}
      </div>

      {frozen && filing.status !== 'void' ? (
        <Alert>
          <AlertDescription>{t('informationReturns.frozenNotice')}</AlertDescription>
        </Alert>
      ) : null}

      {filing.recipients.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t('informationReturns.noRecipients')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('informationReturns.columns.recipient')}</TableHead>
                <TableHead>{t('informationReturns.columns.tin')}</TableHead>
                {amountBoxes.map((box) => (
                  <TableHead key={box.key} className="text-right whitespace-nowrap">
                    {box.number}
                  </TableHead>
                ))}
                <TableHead>{t('informationReturns.columns.status')}</TableHead>
                {canManage && !frozen ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filing.recipients.map((recipient) => (
                <TableRow key={recipient.id} className={recipient.status !== 'included' ? 'opacity-60' : undefined}>
                  <TableCell className="font-medium">
                    <Link href={`/compliance/vendors?vendor=${recipient.partyId}`} className="hover:underline">
                      {recipient.legalName ?? recipient.vendorName}
                    </Link>
                    {recipient.adjustmentReason ? (
                      <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">{recipient.adjustmentReason}</p>
                    ) : null}
                    {recipient.exclusionReason ? (
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{recipient.exclusionReason}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                    {recipient.tinLast4 ? `•••${recipient.tinLast4}` : (
                      <Badge variant="destructive">{t('readiness.missingTin')}</Badge>
                    )}
                  </TableCell>
                  {amountBoxes.map((box) => {
                    const hasAdjustment = Boolean(recipient.adjustments[box.key])
                    return (
                      <TableCell key={box.key} className="text-right tabular-nums whitespace-nowrap">
                        {filed(recipient, box.key)}
                        {hasAdjustment ? (
                          <span
                            className="ml-1 text-xs text-slate-400"
                            title={t('informationReturns.ledgerFigure', {
                              value: amount(recipient.computedAmounts[box.key]) || '0.00',
                            })}
                          >
                            *
                          </span>
                        ) : null}
                      </TableCell>
                    )
                  })}
                  <TableCell>
                    <Badge variant={recipient.status === 'included' ? 'success' : 'secondary'}>
                      {t(`recipientStatus.${recipient.status}`)}
                    </Badge>
                  </TableCell>
                  {canManage && !frozen ? (
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEditor(recipient)}>
                        {t('informationReturns.adjust')}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400">{t('informationReturns.footnote')}</p>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.legalName ?? editing?.vendorName ?? ''}
        description={t('informationReturns.adjustDescription')}
        size="md"
      >
        {editing ? (
          <div className="grid gap-3">
            {amountBoxes.map((box) => (
              <div key={box.key} className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                <div>
                  <Label>
                    {box.number} · {box.name}
                  </Label>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('informationReturns.ledgerFigure', {
                      value: amount(editing.computedAmounts[box.key]) || '0.00',
                    })}
                  </p>
                </div>
                <Input
                  className="w-32 text-right tabular-nums"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={draft.adjustments[box.key] ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      adjustments: { ...draft.adjustments, [box.key]: event.target.value },
                    })
                  }
                />
                <span className="pb-2 text-xs text-slate-400">{t('informationReturns.delta')}</span>
              </div>
            ))}
            <div>
              <Label>{t('informationReturns.adjustReason')}</Label>
              <Textarea rows={2} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.excluded}
                onChange={(event) => setDraft({ ...draft, excluded: event.target.checked })}
              />
              {t('informationReturns.exclude')}
            </label>
            {draft.excluded ? (
              <div>
                <Label>{t('informationReturns.exclusionReason')}</Label>
                <Input
                  value={draft.exclusionReason}
                  onChange={(event) => setDraft({ ...draft, exclusionReason: event.target.value })}
                />
              </div>
            ) : null}
            <Button disabled={pending} onClick={saveRecipient}>
              {t('fields.save')}
            </Button>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={fileOpen}
        onClose={() => setFileOpen(false)}
        title={t('informationReturns.markFiled')}
        size="sm"
      >
        <div className="grid gap-3">
          <div>
            <Label>{t('informationReturns.channel')}</Label>
            <Select value={filingChannel} onChange={(event) => setFilingChannel(event.target.value)}>
              {FILING_CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {t(`filingChannel.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('informationReturns.reference')}</Label>
            <Input value={filingReference} onChange={(event) => setFilingReference(event.target.value)} />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('informationReturns.referenceHint')}</p>
          </div>
          <Button
            disabled={pending}
            onClick={async () => {
              const ok = await post({ action: 'file', channel: filingChannel, reference: filingReference || null })
              if (ok) setFileOpen(false)
            }}
          >
            {t('informationReturns.markFiled')}
          </Button>
        </div>
      </Drawer>
    </div>
  )
}

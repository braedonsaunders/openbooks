'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { useAppAction } from '@/lib/use-app-action'

type EvidenceKind = 'billing_address' | 'ip_country' | 'card_bin_country' | 'bank_country' | 'sim_country' | 'ship_to'

interface EvidenceRow {
  kind: string
  countryCode: string
  source: string
  observedOn: string | null
}

interface Verdict {
  outcome: string
  country: string
  evidence: string[]
  vatId: string | null
}

interface EvidencePayload {
  election: { supplyKind: string; customerKind: string } | null
  verdict: Verdict | null
  evidence: EvidenceRow[]
  correctedDocument: { id: string; number: string } | null
}

const OUTCOME_VARIANT: Record<string, 'success' | 'secondary' | 'outline' | 'warning'> = {
  customer_country: 'success',
  reverse_charge: 'secondary',
  seller_country: 'outline',
  export: 'warning',
}

/**
 * Place-of-supply evidence on a sales document. Everyday: the frozen verdict
 * and one chip per collected signal. Configure (drafts the actor may edit):
 * the supply classification and its signals, saved in one unit for the
 * posting boundary to judge. Posted documents show the record read-only.
 */
export function SupplyEvidencePanel({
  documentId,
  status,
  canManage,
}: {
  documentId: string
  status: string
  canManage: boolean
}) {
  const t = useTranslations('ar.supplyEvidence')
  const [payload, setPayload] = useState<EvidencePayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [supplyKind, setSupplyKind] = useState<'digital_service' | 'goods'>('digital_service')
  const [customerKind, setCustomerKind] = useState<'consumer' | 'business'>('consumer')
  const [rows, setRows] = useState<{ kind: EvidenceKind; country: string; source: string }[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()
  const draft = status === 'draft'

  async function load() {
    setLoadError(null)
    const res = await fetch(`/api/documents/${documentId}/supply-evidence`)
    if (!res.ok) {
      setLoadError(t('loadFailed'))
      return
    }
    const data = (await res.json()) as EvidencePayload
    setPayload(data)
    if (data.election) {
      if (data.election.supplyKind === 'goods') setSupplyKind('goods')
      if (data.election.customerKind === 'business') setCustomerKind('business')
    }
    setRows(
      data.evidence.map((row) => ({ kind: row.kind as EvidenceKind, country: row.countryCode, source: row.source })),
    )
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  async function runSave(): Promise<ActionResult<unknown>> {
    try {
      const res = await fetch(`/api/documents/${documentId}/supply-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ election: { supplyKind, customerKind }, evidence: rows }),
      })
      if (!res.ok) {
        return {
          ok: false as const,
          error: new ActionError({
            kind: kindForStatus(res.status),
            status: res.status,
            code: 'save',
            serverMessage: await readApiErrorMessage(res, t('saveFailed')),
          }),
        }
      }
      return { ok: true as const, status: res.status, data: await res.json().catch(() => ({})) }
    } catch (error) {
      return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
    }
  }

  async function save() {
    setSaveError(null)
    const fallback = t('saveFailed')
    await execute(() => runSave(), {
      fallbackMessage: fallback,
      onRefused: (error) => setSaveError(error.displayMessage(fallback)),
      onOk: () => {
        setEditing(false)
        void load()
      },
    })
  }

  const verdict = payload?.verdict ?? null
  return (
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {t('title')}
      </h3>
      {loadError ? <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p> : null}
      {!payload ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('loading')}</p>
      ) : !payload.election && !editing ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('domestic')}</p>
          {draft && canManage ? (
            <Button variant="outline" size="sm" onClick={() => { setRows([]); setEditing(true) }}>
              {t('elect')}
            </Button>
          ) : null}
        </div>
      ) : editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('supplyKind')}</Label>
              <Select value={supplyKind} onChange={(event) => setSupplyKind(event.target.value as 'digital_service' | 'goods')}>
                <option value="digital_service">{t('supplyKindOptions.digital_service')}</option>
                <option value="goods">{t('supplyKindOptions.goods')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('customerKind')}</Label>
              <Select value={customerKind} onChange={(event) => setCustomerKind(event.target.value as 'consumer' | 'business')}>
                <option value="consumer">{t('customerKindOptions.consumer')}</option>
                <option value="business">{t('customerKindOptions.business')}</option>
              </Select>
            </div>
          </div>
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-[1fr_5rem_1fr_auto] items-end gap-2">
              <div className="space-y-1.5">
                <Label>{t('signal')}</Label>
                <Select
                  value={row.kind}
                  onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, kind: event.target.value as EvidenceKind } : r)))}
                >
                  {(['billing_address', 'ip_country', 'card_bin_country', 'bank_country', 'sim_country', 'ship_to'] as const).map((kind) => (
                    <option key={kind} value={kind}>{t(`kinds.${kind}`)}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('country')}</Label>
                <Input
                  value={row.country}
                  maxLength={2}
                  onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, country: event.target.value.toUpperCase() } : r)))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('source')}</Label>
                <Input
                  value={row.source}
                  maxLength={40}
                  onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, source: event.target.value } : r)))}
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                {t('remove')}
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setRows([...rows, { kind: 'billing_address', country: '', source: '' }])}>
              {t('addSignal')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? t('saving') : t('save')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
          {saveError ? <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p> : null}
        </div>
      ) : (
        <div className="space-y-2">
          {verdict ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={OUTCOME_VARIANT[verdict.outcome] ?? 'secondary'}>
                {t(`outcomes.${verdict.outcome}`, { country: verdict.country })}
              </Badge>
              {verdict.vatId ? (
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('vatId', { id: verdict.vatId })}</span>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('pending')}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {payload.correctedDocument ? (
              <Badge variant="secondary">{t('correctsInvoice', { number: payload.correctedDocument.number })}</Badge>
            ) : null}
            {payload.evidence.map((row) => (
              <Badge key={`${row.kind}-${row.source}`} variant="outline">
                {t(`kinds.${row.kind}`)} · {row.countryCode}
              </Badge>
            ))}
          </div>
          {draft && canManage ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  )
}

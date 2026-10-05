'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { useAppAction } from '@/lib/use-app-action'

type TaxIdRow = {
  id: string
  scheme: string
  value: string
  status: string
  checkedAt: string | null
  consultationNumber: string | null
  revalidateAfter: string | null
}

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning'> = {
  valid: 'success',
  invalid: 'destructive',
  unverified: 'warning',
}

/**
 * Business tax IDs on a customer record. Everyday: each number with its
 * verdict — "VAT ID valid (VIES, checked 2 Oct)". Configure: record another
 * number, or re-run validation against the authority. An outage keeps the
 * previous verdict and says so instead of flipping it.
 */
export function PartyTaxIdSection({ partyId, canManage }: { partyId: string; canManage: boolean }) {
  const t = useTranslations('parties.taxIds')
  const [rows, setRows] = useState<TaxIdRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scheme, setScheme] = useState<'vies' | 'hmrc' | 'abn' | 'gst'>('vies')
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function load() {
    setLoadError(null)
    const res = await fetch(`/api/party-tax-ids?partyId=${encodeURIComponent(partyId)}`)
    if (!res.ok) {
      setLoadError(t('loadFailed'))
      return
    }
    const data = (await res.json()) as { taxIds: TaxIdRow[] }
    setRows(data.taxIds)
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId])

  async function runRequest(url: string, init: RequestInit, fallback: string): Promise<ActionResult<unknown>> {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        return {
          ok: false as const,
          error: new ActionError({
            kind: kindForStatus(res.status),
            status: res.status,
            code: 'save',
            serverMessage: await readApiErrorMessage(res, fallback),
          }),
        }
      }
      return { ok: true as const, status: res.status, data: await res.json().catch(() => ({})) }
    } catch (error) {
      return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
    }
  }

  async function add() {
    setFormError(null)
    const fallback = t('saveFailed')
    await execute(
      () =>
        runRequest(
          '/api/party-tax-ids',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partyId, scheme, value }),
          },
          fallback,
        ),
      {
        fallbackMessage: fallback,
        onRefused: (error) => setFormError(error.displayMessage(fallback)),
        onOk: () => {
          setValue('')
          void load()
        },
      },
    )
  }

  async function validate(row: TaxIdRow) {
    setFormError(null)
    const fallback = t('validateFailed')
    await execute(() => runRequest(`/api/party-tax-ids/${row.id}/validate`, { method: 'POST' }, fallback), {
      fallbackMessage: fallback,
      onRefused: (error) => setFormError(error.displayMessage(fallback)),
      onOk: () => {
        void load()
      },
    })
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
      </div>
      {loadError ? <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"
            >
              <span className="font-mono text-sm">{row.value}</span>
              <Badge variant={STATUS_VARIANT[row.status] ?? 'warning'}>
                {t(`status.${row.status}`, { scheme: t(`schemes.${row.scheme}`) })}
              </Badge>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {row.checkedAt
                  ? t('checked', { date: row.checkedAt.slice(0, 10) })
                  : t('neverChecked')}
                {row.consultationNumber ? ` · ${t('consultation', { id: row.consultationNumber })}` : null}
              </span>
              {canManage ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void validate(row)}>
                  {busy ? t('validating') : t('validate')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="grid grid-cols-[10rem_1fr_auto] items-end gap-2">
          <div className="space-y-1.5">
            <Label>{t('scheme')}</Label>
            <Select value={scheme} onChange={(event) => setScheme(event.target.value as typeof scheme)}>
              {(['vies', 'hmrc', 'abn', 'gst'] as const).map((option) => (
                <option key={option} value={option}>{t(`schemes.${option}`)}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('number')}</Label>
            <Input value={value} maxLength={40} onChange={(event) => setValue(event.target.value)} placeholder={t('numberPlaceholder')} />
          </div>
          <Button size="sm" disabled={busy || !value.trim()} onClick={() => void add()}>
            {t('add')}
          </Button>
        </div>
      ) : null}
      {formError ? <p className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}
    </section>
  )
}

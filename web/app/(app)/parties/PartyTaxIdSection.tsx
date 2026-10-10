'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BadgeCheck } from 'lucide-react'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, Drawer, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError, SublistPager, useSublistRows } from '@/components/drawer-sublist'
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
 * number from the Add drawer, or re-run validation against the authority.
 * An outage keeps the previous verdict and says so instead of flipping it.
 */
export function PartyTaxIdSection({ partyId, canManage }: { partyId: string; canManage: boolean }) {
  const t = useTranslations('parties.taxIds')
  const tc = useTranslations('common')
  const ids = useId()
  const [adding, setAdding] = useState(false)
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
          setAdding(false)
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

  const taxIdText = useCallback((row: TaxIdRow) => `${row.value} ${row.scheme} ${row.status}`, [])
  const list = useSublistRows(rows, taxIdText)

  return (
    <DrawerSublist
      title={t('title')}
      description={t('hint')}
      icon={<BadgeCheck size={16} />}
      action={canManage ? <SublistAddButton label={t('addTaxId')} onClick={() => { setFormError(null); setValue(''); setAdding(true) }} /> : undefined}
      alert={!adding && formError ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}
      search={rows.length ? { value: list.query, onChange: list.setQuery, placeholder: t('search') } : undefined}
      footer={rows.length ? <SublistPager page={list.page} pages={list.pages} onPage={list.setPage} /> : null}
    >
      {loadError ? (
        <SublistLoadError message={loadError} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <SublistEmpty icon={<BadgeCheck size={22} />} text={t('empty')} />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t('number')}</TableHead>
            <TableHead>{t('scheme')}</TableHead>
            <TableHead>{t('verdict')}</TableHead>
            <TableHead>{t('lastChecked')}</TableHead>
            {canManage ? <TableHead className="text-right">{tc('labels.actions')}</TableHead> : null}
          </TableRow></TableHeader>
          <TableBody>
            {list.shown.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.value}</TableCell>
                <TableCell>{t(`schemes.${row.scheme}`)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[row.status] ?? 'warning'}>
                    {t(`status.${row.status}`, { scheme: t(`schemes.${row.scheme}`) })}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-slate-500 dark:text-slate-400">
                  {row.checkedAt
                    ? t('checked', { date: row.checkedAt.slice(0, 10) })
                    : t('neverChecked')}
                  {row.consultationNumber ? ` · ${t('consultation', { id: row.consultationNumber })}` : null}
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void validate(row)}>
                      {busy ? t('validating') : t('validate')}
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage ? (
        <Drawer
          open={adding}
          onClose={() => { if (!busy) setAdding(false) }}
          stacked
          size="md"
          title={t('addTaxId')}
          description={t('addDescription')}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => setAdding(false)}>{tc('actions.cancel')}</Button>
              <Button disabled={busy || !value.trim()} onClick={() => void add()}>{busy ? tc('actions.saving') : t('add')}</Button>
            </>
          )}
        >
          <div className="space-y-4">
            {formError ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}
            <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-scheme`}>{t('scheme')}</Label>
                <Select id={`${ids}-scheme`} value={scheme} onChange={(event) => setScheme(event.target.value as typeof scheme)}>
                  {(['vies', 'hmrc', 'abn', 'gst'] as const).map((option) => (
                    <option key={option} value={option}>{t(`schemes.${option}`)}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-number`}>{t('number')}</Label>
                <Input id={`${ids}-number`} value={value} maxLength={40} onChange={(event) => setValue(event.target.value)} placeholder={t('numberPlaceholder')} />
              </div>
            </div>
          </div>
        </Drawer>
      ) : null}
    </DrawerSublist>
  )
}


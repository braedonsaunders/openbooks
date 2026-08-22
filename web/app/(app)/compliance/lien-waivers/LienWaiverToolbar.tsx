'use client'

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { useBusinessToday } from '../../../../components/business-date-provider'

const WAIVER_TYPES = [
  'conditional_progress',
  'unconditional_progress',
  'conditional_final',
  'unconditional_final',
] as const

const STATUSES = ['draft', 'requested', 'received', 'signed', 'rejected', 'void'] as const

/**
 * Filters plus the create form. The waiver type defaults from the
 * subcontractor's compliance class, so the form the office actually collects is
 * pre-selected instead of being chosen afresh each time.
 */
export function LienWaiverToolbar({
  direction,
  status,
  projects,
  vendors,
  canManage,
}: {
  direction: string
  status: string
  projects: { id: string; label: string }[]
  vendors: { id: string; label: string; defaultType: string }[]
  canManage: boolean
}) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const params = useSearchParams()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({
    direction: 'received',
    partyId: '',
    projectId: '',
    waiverType: 'unconditional_progress',
    throughDate: useBusinessToday(),
    amount: '',
    jurisdiction: '',
  })

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('waiver')
    router.push(`/compliance/lien-waivers${next.toString() ? `?${next}` : ''}`)
  }

  function pickVendor(partyId: string) {
    const vendor = vendors.find((v) => v.id === partyId)
    setForm({
      ...form,
      partyId,
      waiverType: vendor?.defaultType || form.waiverType,
    })
  }

  async function create() {
    setError(null)
    if (!form.partyId || !form.projectId) {
      setError(t('lienWaivers.errors.partyAndProject'))
      return
    }
    const res = await fetch('/api/compliance/lien-waivers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        direction: form.direction,
        partyId: form.partyId,
        projectId: form.projectId,
        waiverType: form.waiverType,
        throughDate: form.throughDate,
        amount: form.amount || null,
        jurisdiction: form.jurisdiction || null,
      }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? t('errors.saveFailed'))
      return
    }
    const created = (await res.json()) as { id: string }
    setOpen(false)
    startTransition(() => router.push(`/compliance/lien-waivers?waiver=${created.id}`))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={t('lienWaivers.filters.direction')}
        value={direction}
        onChange={(event) => setParam('direction', event.target.value)}
        className="w-44"
      >
        <option value="">{t('lienWaivers.filters.allDirections')}</option>
        <option value="received">{t('direction.received')}</option>
        <option value="issued">{t('direction.issued')}</option>
      </Select>
      <Select
        aria-label={t('lienWaivers.filters.status')}
        value={status}
        onChange={(event) => setParam('status', event.target.value)}
        className="w-44"
      >
        <option value="">{t('lienWaivers.filters.allStatuses')}</option>
        {STATUSES.map((value) => (
          <option key={value} value={value}>
            {t(`waiverStatus.${value}`)}
          </option>
        ))}
      </Select>
      {canManage ? (
        <Button className="ml-auto" onClick={() => setOpen(true)}>
          {t('lienWaivers.new')}
        </Button>
      ) : null}

      <Drawer open={open} onClose={() => setOpen(false)} title={t('lienWaivers.new')} size="md">
        <div className="grid gap-3">
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          ) : null}
          <div>
            <Label>{t('lienWaivers.columns.direction')}</Label>
            <Select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value })}>
              <option value="received">{t('direction.received')}</option>
              <option value="issued">{t('direction.issued')}</option>
            </Select>
          </div>
          <div>
            <Label>{t('lienWaivers.columns.party')}</Label>
            <Select value={form.partyId} onChange={(event) => pickVendor(event.target.value)}>
              <option value="">{t('fields.select')}</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('lienWaivers.columns.project')}</Label>
            <Select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
              <option value="">{t('fields.select')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('lienWaivers.columns.type')}</Label>
            <Select value={form.waiverType} onChange={(event) => setForm({ ...form, waiverType: event.target.value })}>
              {WAIVER_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`waiverType.${value}`)}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t(`waiverTypeHint.${form.waiverType}`)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('lienWaivers.columns.through')}</Label>
              <Input
                type="date"
                value={form.throughDate}
                onChange={(event) => setForm({ ...form, throughDate: event.target.value })}
              />
            </div>
            <div>
              <Label>{t('lienWaivers.columns.amount')}</Label>
              <Input
                inputMode="decimal"
                className="text-right tabular-nums"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>{t('lienWaivers.columns.jurisdiction')}</Label>
            <Input
              placeholder="US-CA"
              value={form.jurisdiction}
              onChange={(event) => setForm({ ...form, jurisdiction: event.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('lienWaivers.jurisdictionHint')}</p>
          </div>
          <Button disabled={pending} onClick={create}>
            {t('lienWaivers.create')}
          </Button>
        </div>
      </Drawer>
    </div>
  )
}

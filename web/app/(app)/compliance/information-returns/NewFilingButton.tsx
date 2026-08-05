'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'

/**
 * Open a year's filing. Creating and computing are one click here because the
 * computation is read-only and freely repeatable — the consequential steps
 * (finalize, file) live on the filing itself behind their own permission.
 */
export function NewFilingButton({ formTypes, defaultYear }: { formTypes: string[]; defaultYear: number }) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ taxYear: String(defaultYear), formType: formTypes[0] ?? '1099-NEC' })

  async function create() {
    setError(null)
    const res = await fetch('/api/compliance/information-returns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taxYear: Number(form.taxYear), formType: form.formType }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? t('errors.saveFailed'))
      return
    }
    const filing = (await res.json()) as { id: string }
    setOpen(false)
    startTransition(() => router.push(`/compliance/information-returns/${filing.id}`))
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('informationReturns.new')}</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('informationReturns.new')} size="sm">
        <div className="grid gap-3">
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          ) : null}
          <div>
            <Label>{t('informationReturns.columns.year')}</Label>
            <Input
              inputMode="numeric"
              maxLength={4}
              value={form.taxYear}
              onChange={(event) => setForm({ ...form, taxYear: event.target.value })}
            />
          </div>
          <div>
            <Label>{t('informationReturns.columns.form')}</Label>
            <Select value={form.formType} onChange={(event) => setForm({ ...form, formType: event.target.value })}>
              {formTypes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          <Button disabled={pending} onClick={create}>
            {t('informationReturns.create')}
          </Button>
        </div>
      </Drawer>
    </>
  )
}

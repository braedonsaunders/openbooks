'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, Popover, Select } from '@openbooks/ui'

export function NewBudgetButton({
  books,
  years,
  sources,
}: {
  books: { id: string; code: string; name: string; is_primary: boolean }[]
  years: number[]
  sources: { id: string; name: string; fiscal_year: number }[]
}) {
  const t = useTranslations('budgets')
  const tc = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const [year, setYear] = useState(String(years[0] ?? new Date().getFullYear()))
  const [kind, setKind] = useState('budget')
  const [sourceScenarioId, setSourceScenarioId] = useState('')

  async function create() {
    setBusy(true)
    try {
      const response = await fetch('/api/budgets/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || t('create.defaultName', { year, kind: t(`kind.${kind}`) }),
          bookId,
          fiscalYear: Number(year),
          kind,
          sourceScenarioId: sourceScenarioId || null,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setOpen(false)
      router.push(`/budgets/${data.id}`)
      router.refresh()
    } catch {
      toast.error(t('create.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[min(26rem,calc(100vw-2rem))] p-4"
      trigger={
        <Button size="sm" onClick={() => setOpen((value) => !value)}>
          <Plus size={16} />
          {t('list.new')}
        </Button>
      }
    >
      <div className="space-y-4">
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t('create.title')}</h2>
        <div className="space-y-1.5">
          <Label htmlFor="budget-name">{t('create.name')}</Label>
          <Input id="budget-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('create.namePlaceholder')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="budget-book">{t('create.book')}</Label>
            <Select id="budget-book" value={bookId} onChange={(event) => setBookId(event.target.value)}>
              {books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget-year">{t('create.year')}</Label>
            <Select id="budget-year" value={year} onChange={(event) => setYear(event.target.value)}>
              {years.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget-kind">{t('create.kind')}</Label>
            <Select id="budget-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="budget">{t('kind.budget')}</option>
              <option value="forecast">{t('kind.forecast')}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget-source">{t('create.source')}</Label>
            <Select id="budget-source" value={sourceScenarioId} onChange={(event) => setSourceScenarioId(event.target.value)}>
              <option value="">{t('create.blank')}</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{t('create.sourceOption', { name: source.name, year: source.fiscal_year })}</option>)}
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>{tc('actions.cancel')}</Button>
          <Button size="sm" onClick={create} disabled={busy || !bookId || !year}>{busy ? t('create.creating') : t('list.new')}</Button>
        </div>
      </div>
    </Popover>
  )
}

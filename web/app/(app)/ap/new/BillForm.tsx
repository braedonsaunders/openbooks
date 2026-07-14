'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { money } from '../../../../lib/format'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
}
interface Line {
  accountId: string
  description: string
  amount: string
  taxCodeId: string
}

export function BillForm({ vendors, accounts, taxCodes }: { vendors: Opt[]; accounts: Opt[]; taxCodes: Opt[] }) {
  const today = new Date().toISOString().slice(0, 10)
  const [partyId, setPartyId] = useState('')
  const [documentDate, setDocumentDate] = useState(today)
  const [dueDate, setDueDate] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<Line[]>([{ accountId: '', description: '', amount: '', taxCodeId: '' }])
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const subtotal = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0)

  async function save() {
    setBusy(true)
    const res = await fetch('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId,
        documentDate,
        dueDate: dueDate || undefined,
        referenceNumber,
        memo,
        lines: lines
          .filter((l) => l.accountId && Number(l.amount) > 0)
          .map((l) => ({ ...l, taxCodeId: l.taxCodeId || undefined })),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Could not save the bill')
      setBusy(false)
      return
    }
    toast.success(`${data.documentNumber} saved as draft`)
    router.push('/ap')
    router.refresh()
  }

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
            <Label>Vendor</Label>
            <SearchSelect
              options={vendors.map((v) => ({ value: v.id, label: v.display_name ?? '' }))}
              value={partyId}
              onChange={(v) => setPartyId(v ?? '')}
              placeholder="Select vendor…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-date">Bill date</Label>
            <Input id="bill-date" type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="due-date">Due date</Label>
            <Input id="due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref">Vendor ref #</Label>
            <Input id="ref" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
          </div>
        </div>

        <div className="space-y-3">
          <Label>Lines</Label>
          {lines.map((l, i) => (
            <div key={i} className="grid items-start gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_120px_130px_36px]">
              <SearchSelect
                options={accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
                value={l.accountId}
                onChange={(v) => setLine(i, { accountId: v ?? '' })}
                placeholder="Account…"
              />
              <Input
                placeholder="Description"
                value={l.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
              <Input
                inputMode="decimal"
                placeholder="0.00"
                className="text-right tabular-nums"
                value={l.amount}
                onChange={(e) => setLine(i, { amount: e.target.value })}
              />
              <Select value={l.taxCodeId} onChange={(e) => setLine(i, { taxCodeId: e.target.value })}>
                <option value="">No tax</option>
                {taxCodes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((ls) => [...ls, { accountId: '', description: '', amount: '', taxCodeId: '' }])}
          >
            <Plus size={14} /> Add line
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="memo">Memo</Label>
          <Input id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Subtotal (pre-tax):{' '}
            <strong className="text-slate-900 tabular-nums dark:text-slate-100">{money(subtotal)}</strong>
          </span>
          <Button disabled={busy || !partyId} onClick={save}>
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

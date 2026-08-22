'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { PackageX } from 'lucide-react'
import { Button, Input, Label, Popover, Select } from '@openbooks/ui'
import { useBusinessToday } from '../../../components/business-date-provider'

type AccountOpt = { value: string; label: string }

/** Dispose an asset by sale (or write it off) — posts the disposal journal and
 *  flips the asset's status. Shown in the asset drawer for in-service assets. */
export function DisposeButton({ assetId, accountOptions }: { assetId: string; accountOptions: AccountOpt[] }) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [writeOff, setWriteOff] = useState(false)
  const [proceeds, setProceeds] = useState('')
  const [account, setAccount] = useState('')
  const [date, setDate] = useState(useBusinessToday())
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/dispose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          writeOff,
          proceeds: writeOff ? '0' : proceeds.trim() || '0',
          proceedsAccountId: writeOff ? undefined : account || undefined,
        }),
      })
      const d = (await res.json().catch(() => ({}))) as { error?: string; gainLoss?: string; status?: string }
      if (!res.ok) throw new Error(d.error)
      toast.success(t('dispose.done', { gainLoss: d.gainLoss ?? '0' }))
      setOpen(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="outline">
          <PackageX size={15} className="mr-1.5" />
          {t('dispose.label')}
        </Button>
      }
    >
      <div className="w-72 space-y-3 p-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} />
          {t('dispose.writeOff')}
        </label>
        {!writeOff ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="disp-proceeds">{t('dispose.proceeds')}</Label>
              <Input id="disp-proceeds" type="number" min="0" step="0.01" value={proceeds}
                onChange={(e) => setProceeds(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="disp-account">{t('dispose.account')}</Label>
              <Select id="disp-account" value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">{t('dispose.selectAccount')}</option>
                {accountOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
          </>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="disp-date">{t('dispose.date')}</Label>
          <Input id="disp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button className="w-full" onClick={submit} disabled={busy}>
          {busy ? t('dispose.working') : writeOff ? t('dispose.writeOffAction') : t('dispose.action')}
        </Button>
      </div>
    </Popover>
  )
}

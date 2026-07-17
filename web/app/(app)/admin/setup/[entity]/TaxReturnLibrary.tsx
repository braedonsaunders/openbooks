'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Library } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Select } from '@openbooks/ui'

export interface TaxPackOption {
  code: string
  name: string
  country: string
}

export function TaxReturnLibrary({ packs, installedCodes }: { packs: TaxPackOption[]; installedCodes: string[] }) {
  const t = useTranslations('admin.setup.taxLibrary')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [code, setCode] = useState(packs[0]?.code ?? '')
  const [busy, setBusy] = useState(false)
  const installed = useMemo(() => new Set(installedCodes), [installedCodes])
  const selected = packs.find((pack) => pack.code === code)

  async function install() {
    if (!code) return
    setBusy(true)
    try {
      const response = await fetch('/api/tax/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack: code }),
      })
      if (!response.ok) throw new Error()
      toast.success(installed.has(code) ? t('resetSuccess') : t('importSuccess'))
      router.refresh()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Library className="mt-0.5 text-teal-600 dark:text-teal-400" size={20} />
          <div>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor="tax-pack">{t('pack')}</Label>
          <Select id="tax-pack" value={code} onChange={(event) => setCode(event.target.value)}>
            {packs.map((pack) => (
              <option key={pack.code} value={pack.code}>
                {installed.has(pack.code)
                  ? t('optionInstalled', { country: pack.country, name: pack.name })
                  : t('optionAvailable', { country: pack.country, name: pack.name })}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={install} disabled={busy || !selected}>
          {busy ? t('working') : installed.has(code) ? t('reset') : t('import')}
        </Button>
        {code === 'US_SALES_TAX_WORKPAPER' ? (
          <p className="w-full text-xs text-amber-700 dark:text-amber-300">{t('usNotice')}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

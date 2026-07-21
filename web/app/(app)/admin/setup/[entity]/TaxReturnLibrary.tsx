'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Library } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Label, Select, UrlDrawer } from '@openbooks/ui'

export interface TaxPackOption {
  code: string
  name: string
  country: string
}

export function TaxReturnLibrary({
  packs,
  installedCodes,
  open,
  openHref,
  closeHref,
}: {
  packs: TaxPackOption[]
  installedCodes: string[]
  open: boolean
  openHref: string
  closeHref: string
}) {
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
    <>
      <Button asChild variant="outline" size="sm">
        <Link href={openHref as any}>
          <Library size={14} />
          {t('open')}
        </Link>
      </Button>
      {open ? (
        <UrlDrawer
          open
          closeHref={closeHref}
          size="md"
          title={t('title')}
          description={t('description')}
          footer={
            <Button onClick={install} disabled={busy || !selected}>
              {busy ? t('working') : installed.has(code) ? t('reset') : t('import')}
            </Button>
          }
        >
          <div className="space-y-4 p-1">
            <div className="space-y-1.5">
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
            {code === 'US_SALES_TAX_WORKPAPER' ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('usNotice')}</p>
            ) : null}
          </div>
        </UrlDrawer>
      ) : null}
    </>
  )
}

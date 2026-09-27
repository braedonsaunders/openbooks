'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../../lib/api-error'
import type { ManufacturingPolicies } from '@openbooks/engine/src/manufacturing/policies.ts'

export function ManufacturingPoliciesForm({ initial }: { initial: ManufacturingPolicies }) {
  const t = useTranslations('admin.setup.entities.manufacturing-policies')
  const router = useRouter()
  const [shortagePolicy, setShortagePolicy] = useState(initial.shortagePolicy)
  const [completionTolerancePct, setCompletionTolerancePct] = useState(initial.completionTolerancePct)
  const [threshold, setThreshold] = useState(initial.abnormalScrapApprovalThreshold ?? '')
  const [saving, setSaving] = useState(false)

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/manufacturing/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortagePolicy,
          completionTolerancePct,
          abnormalScrapApprovalThreshold: threshold === '' ? null : threshold,
        }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('failed')))
      await res.json()
      toast.success(t('saved'))
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form className="space-y-4" onSubmit={save}>
          <div className="space-y-1.5">
            <Label htmlFor="mfg-shortage-policy">{t('shortage')}</Label>
            <Select id="mfg-shortage-policy" value={shortagePolicy} onChange={(event) => setShortagePolicy(event.target.value as 'warn' | 'refuse')}>
              <option value="warn">{t('warn')}</option>
              <option value="refuse">{t('refuse')}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfg-completion-tolerance">{t('tolerance')}</Label>
            <Input id="mfg-completion-tolerance" inputMode="decimal" value={completionTolerancePct} onChange={(event) => setCompletionTolerancePct(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfg-scrap-threshold">{t('threshold')}</Label>
            <Input id="mfg-scrap-threshold" inputMode="decimal" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('thresholdHelp')}</p>
          </div>
          <Button type="submit" disabled={saving}>{saving ? t('saving') : t('save')}</Button>
        </form>
      </CardContent>
    </Card>
  )
}

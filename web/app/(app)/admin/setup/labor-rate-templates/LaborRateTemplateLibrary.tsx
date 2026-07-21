'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@openbooks/ui'
import type { LaborRateTemplate } from '../../../../../lib/labor-rate-templates'

export function LaborRateTemplateLibrary({
  templates,
  currencies,
  defaultCurrency,
}: {
  templates: LaborRateTemplate[]
  currencies: { code: string; name: string }[]
  defaultCurrency: string
}) {
  const t = useTranslations('admin.setup')
  const router = useRouter()
  const [selected, setSelected] = useState<LaborRateTemplate | null>(null)
  const [currency, setCurrency] = useState(defaultCurrency)
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10))
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  function choose(template: LaborRateTemplate) {
    setSelected(template)
    setCode(template.code)
    setName(template.name)
  }

  async function install() {
    if (!selected) return
    setBusy(true)
    try {
      const response = await fetch('/api/admin/setup/labor-rate-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: selected.id, currency, effectiveFrom, code, name }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || t('templates.installError'))
      toast.success(t('templates.installed'))
      router.push(`/admin/setup/item-rate-versions?row=${payload.versionId}`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('templates.installError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        {templates.map((template) => (
          <Card key={template.id} className={selected?.id === template.id ? 'border-teal-500 ring-1 ring-teal-500/30' : undefined}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{t(template.titleKey)}</CardTitle>
                  <CardDescription className="mt-1">{t(template.descriptionKey)}</CardDescription>
                </div>
                <Badge variant="outline">{t('templates.draftBadge')}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span>{t('templates.classCount', { count: template.classes.length })}</span>
                <span>·</span>
                <span>{t('templates.rateCount', { count: template.lines.length })}</span>
                <span>·</span>
                <span>{t('templates.componentCount', { count: template.components.length })}</span>
              </div>
              <Button variant={selected?.id === template.id ? 'default' : 'outline'} size="sm" onClick={() => choose(template)}>
                {selected?.id === template.id ? t('templates.selected') : t('templates.useTemplate')}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('templates.createTitle', { template: t(selected.titleKey) })}</CardTitle>
            <CardDescription>{t('templates.createDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="template-code">{t('fields.code')}</Label><Input id="template-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} /></div>
              <div className="space-y-1.5"><Label htmlFor="template-name">{t('fields.name')}</Label><Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="template-currency">{t('fields.currency')}</Label><Select id="template-currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</Select></div>
              <div className="space-y-1.5"><Label htmlFor="template-date">{t('fields.effectiveFrom')}</Label><Input id="template-date" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              {t('templates.reviewHint')}
            </div>
            <Button disabled={busy || !code || !name || !effectiveFrom} onClick={install}>
              {busy ? t('templates.installing') : t('templates.createDraft')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

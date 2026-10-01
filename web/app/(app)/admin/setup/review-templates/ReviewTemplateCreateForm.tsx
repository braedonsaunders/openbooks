'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, TagInput } from '@openbooks/ui'
import { createSetupRow } from '../../../../../lib/setup/builder-client'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../../../components/dirty-url-drawer'
import { isUuid } from '../../../../../lib/list-params'

/** Create through the same audited Setup writer used by the form builder. */
export function ReviewTemplateCreateForm({ basePath }: { basePath: string }) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const th = useTranslations('hrm')
  return <DirtyUrlDrawer open title={basePath === '/hrm/performance/templates' ? th('performance.workspace.newReviewForm') : t('newTemplate')} closeHref={basePath}><ReviewTemplateCreateFields basePath={basePath} /></DirtyUrlDrawer>
}

function ReviewTemplateCreateFields({ basePath }: { basePath: string }) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const router = useRouter()
  const [name, setName] = useState('')
  const [scaleMin, setScaleMin] = useState('1')
  const [scaleMax, setScaleMax] = useState('5')
  const [scaleLabels, setScaleLabels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDirtyUrlDrawer(name !== '' || scaleMin !== '1' || scaleMax !== '5' || scaleLabels.length > 0, busy)
  return (
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        const result = await createSetupRow('hrm-review-templates', {
          name: name.trim(), ratingScaleMin: scaleMin, ratingScaleMax: scaleMax, ratingScaleLabels: scaleLabels, isActive: true,
        }, { fallback: tc('feedback.createFailed'), duplicate: t('errors.duplicateName'), inUse: tb('errors.inUse'), stale: tb('errors.stale'), network: tb('errors.network') })
        setBusy(false)
        if (!result.ok) { setError(result.error); return }
        if (typeof result.body.id !== 'string' || !isUuid(result.body.id)) { setError(tc('feedback.createFailed')); return }
        router.push(`${basePath}/${result.body.id}`)
        router.refresh()
      }}>
        <div className="space-y-1.5"><Label htmlFor="new-review-name">{t('fields.name')}</Label><Input id="new-review-name" value={name} onChange={(event) => setName(event.target.value)} required /></div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('ratingScale')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="new-review-min">{t('fields.scaleMin')}</Label><Input id="new-review-min" type="number" step="any" value={scaleMin} onChange={(event) => setScaleMin(event.target.value)} required /></div>
            <div><Label htmlFor="new-review-max">{t('fields.scaleMax')}</Label><Input id="new-review-max" type="number" step="any" value={scaleMax} onChange={(event) => setScaleMax(event.target.value)} required /></div>
          </div>
          <div><Label htmlFor="new-review-labels" help={t('help.scaleLabels')}>{t('fields.scaleLabels')}</Label><TagInput id="new-review-labels" value={scaleLabels} onChange={setScaleLabels} placeholder={t('scaleLabelsPlaceholder')} ariaLabel={t('fields.scaleLabels')} allowNew /></div>
        </fieldset>
        {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <Button disabled={busy || !name.trim() || !scaleMin || !scaleMax || scaleLabels.length === 0}>{tc('actions.create')}</Button>
      </form>
  )
}

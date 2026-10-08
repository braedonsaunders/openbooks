'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { loadDashboardWidgetPreview } from './actions'
import { WIDGETS } from './_widget-registry'
import { CardShell } from './_widget-tiles'
import { WidgetCard } from './_widget-views'

type PreviewResult = Awaited<ReturnType<typeof loadDashboardWidgetPreview>>

export function DeferredWidgetPreview({
  widgetId,
  loadPreview = loadDashboardWidgetPreview,
}: {
  widgetId: string
  loadPreview?: typeof loadDashboardWidgetPreview
}) {
  const t = useTranslations('dashboard')
  const common = useTranslations('common')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setResult(null)
    setFailed(false)
    void loadPreview(widgetId).then(
      (value) => { if (active) setResult(value) },
      () => { if (active) setFailed(true) },
    )
    // Removing a tile or leaving the editor must discard an old response.
    return () => { active = false }
  }, [widgetId, attempt, loadPreview])

  if (result?.ok) return <WidgetCard widgetId={widgetId} data={result.data} />

  const meta = WIDGETS[widgetId]
  const refused = result?.ok === false
  return (
    <CardShell title={meta ? t(meta.labelKey) : widgetId}>
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-slate-500" aria-live="polite">
        {refused ? t('grid.previewUnavailable') : failed ? t('grid.previewFailed') : common('feedback.loading')}
        {(refused || failed) && <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{common('actions.retry')}</Button>}
      </div>
    </CardShell>
  )
}

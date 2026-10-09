"use client";
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Drawer } from '@openbooks/ui'
import { configuredSchedulePdfLayout, type SchedulePdfLayout } from '@openbooks/forms-core'
import type { BoardWindow } from './model'
import type { ScheduleBoardReportPreview } from '@openbooks/engine/src/schedule-boards/board-report.ts'
import { SchedulePdfFields } from './SchedulePdfFields'
import { SchedulingAlert } from './SchedulingAlert'
import { SchedulingRequestError } from './api'
export function DownloadScheduleDrawer({window: initialWindow, onClose}: {window: BoardWindow; onClose: () => void}) {
  const t = useTranslations('scheduling.distribution')
  const [board] = useState(initialWindow)
  const [pdfLayout, setPdfLayout] = useState<SchedulePdfLayout>(() => configuredSchedulePdfLayout(board.board.automaticDeliveryPolicy))
  const [preview, setPreview] = useState<ScheduleBoardReportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{message: string; remedy: string | null} | null>(null)
  function reset() {setPreview(null); setError(null)}
  async function submit(command: 'preview' | 'pdf') {
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/scheduling/boards/${board.board.id}/report`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({command, from: board.from, through: board.through, layout: pdfLayout, ...(command === 'pdf' ? {version: preview?.version} : {})})})
      if (!response.ok) {const body = await response.json().catch(() => ({})); throw new SchedulingRequestError(body.error ?? t('refused'), body.remedy ?? null, body.code ?? null)}
      if (command === 'preview') setPreview(await response.json())
      else {const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'Schedule.pdf'; anchor.click(); URL.revokeObjectURL(url)}
    } catch (cause) {setError({message: cause instanceof Error ? cause.message : t('refused'), remedy: cause instanceof SchedulingRequestError ? cause.remedy : null})}
    finally {setBusy(false)}
  }
  return <Drawer open title={t('downloadPdf')} description={`${board.board.name} · ${board.from} – ${board.through} · ${board.board.timeZone}`} onClose={onClose} size="lg"
    footer={<div className="flex flex-nowrap justify-end gap-2"><Button variant="ghost" onClick={onClose}>{t('close')}</Button><Button variant="outline" disabled={busy} onClick={() => void submit('preview')}>{t('preview')}</Button><Button disabled={busy || !preview} onClick={() => void submit('pdf')}>{busy ? t('working') : t('downloadPdf')}</Button></div>}>
    <div className="space-y-4">
      <SchedulePdfFields pdfLayout={pdfLayout} setPdfLayout={setPdfLayout} disabled={busy} onChange={reset} />
      {error ? <SchedulingAlert message={error.message} remedy={error.remedy} /> : null}
      {preview ? <section className="space-y-2"><p className="text-sm">{preview.boardName} · {preview.from} – {preview.through} · {preview.timeZone}</p><p className="text-xs text-slate-500">{t('version')} <code className="break-all">{preview.version}</code></p><div className="max-h-64 overflow-auto text-sm">{preview.lines.map((line, index) => <p key={index}>{line.date} · {line.subject} · {line.assignment} · {line.hours}</p>)}</div></section> : null}
    </div>
  </Drawer>
}

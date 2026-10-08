'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Select } from '@openbooks/ui'
import type { BoardWindow } from './model'
import type { ScheduleDistributionPreview } from '@openbooks/engine/src/schedule-boards/distribution.ts'
import { SchedulingAlert } from './SchedulingAlert'
import { SchedulingRequestError } from './api'
import { scheduleDistributionEmail } from '@openbooks/emails/schedule-distribution'

export function EmailScheduleDrawer({
  window: initialWindow,
  onClose,
}: {
  window: BoardWindow
  onClose: () => void
}) {
  // Keep the reviewed drawer window stable while the board refreshes behind it.
  const [board] = useState(initialWindow)
  const t = useTranslations('scheduling.distribution')
  const [visibility, setVisibility] = useState<'personal' | 'board'>('personal')
  const [everyone, setEveryone] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ScheduleDistributionPreview | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{
      message: string
      remedy: string | null
    } | null>(null),
    [queued, setQueued] = useState<{
      id: string
      flowId: string
      runId: string
    } | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID()),
    [recipientId, setRecipientId] = useState('')
  const relevant = new Set([
    ...board.entries
      .filter((e) => e.status === 'published')
      .map((e) => e.subjectId),
    ...(board.sourceRecords ?? []).map((r) => r.workerPartyId),
  ])
  const rows = board.rows.filter((r) => relevant.has(r.subjectId))
  function reset() {
    setPreview(null)
    setQueued(null)
    setKey(crypto.randomUUID())
    setError(null)
  }
  async function submit(command: 'preview' | 'send') {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/scheduling/boards/${board.board.id}/distribution`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command,
            from: board.from,
            through: board.through,
            audience: {
              visibility,
              everyone,
              subjectIds: everyone ? [] : [...selected].sort(),
            },
            ...(command === 'send'
              ? { version: preview?.version, reason, key }
              : {}),
          }),
        },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new SchedulingRequestError(
          body.error ?? t('refused'),
          body.remedy ?? null,
          body.code ?? null,
        )
      }
      const result = await response.json()
      if (command === 'preview') {
        setPreview(result)
        setRecipientId(result.recipients[0]?.partyId ?? '')
      } else setQueued(result)
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : t('refused'),
        remedy: cause instanceof SchedulingRequestError ? cause.remedy : null,
      })
    } finally {
      setBusy(false)
    }
  }
  const recipient = preview?.recipients.find((r) => r.partyId === recipientId)
  const report =
    preview && recipient
      ? scheduleDistributionEmail({
          recipient: recipient.name,
          board: preview.boardName,
          from: preview.from,
          through: preview.through,
          timeZone: preview.timeZone,
          version: preview.version,
          lines: recipient.lines,
        })
      : null
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={t('title')}
      description={`${board.board.name} · ${board.from} – ${board.through} · ${board.board.timeZone}`}
      footer={
        <div className="flex flex-nowrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || queued !== null}
            onClick={() => void submit('preview')}
          >
            {t('preview')}
          </Button>
          <Button
            disabled={
              busy ||
              !preview ||
              preview.refusals.length > 0 ||
              !reason.trim() ||
              queued !== null
            }
            onClick={() => void submit('send')}
          >
            {busy ? t('working') : t('send')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{t('explanation')}</p>
        <label className="block text-sm">
          {t('sharing')}
          <Select
            aria-label={t('sharing')}
            value={visibility}
            disabled={busy || queued !== null}
            onChange={(event) => {
              setVisibility(event.target.value as 'personal' | 'board')
              reset()
            }}
            className="mt-1 w-full rounded border p-2 dark:bg-slate-950"
          >
            <option value="personal">{t('personal')}</option>
            <option value="board">{t('wholeBoard')}</option>
          </Select>
        </label>
        {visibility === 'board' ? (
          <SchedulingAlert tone="info" message={t('wholeBoardReview')} />
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={everyone}
            disabled={busy || queued !== null}
            onChange={(event) => {
              setEveryone(event.target.checked)
              reset()
            }}
          />
          {t('everyone')}
        </label>
        {!everyone ? (
          <div className="max-h-48 overflow-auto rounded-lg border p-3">
            {rows.map((row) => (
              <label
                key={row.subjectId}
                className="flex items-center gap-2 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(row.subjectId)}
                  disabled={busy || queued !== null}
                  onChange={(event) => {
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, row.subjectId]
                        : ids.filter((id) => id !== row.subjectId),
                    )
                    reset()
                  }}
                />
                {row.name}
              </label>
            ))}
          </div>
        ) : null}
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy || queued !== null}
          placeholder={t('reason')}
          aria-label={t('reason')}
        />
        {error ? (
          <SchedulingAlert message={error.message} remedy={error.remedy} />
        ) : null}
        {queued ? (
          <>
            <SchedulingAlert
              tone="info"
              message={t('queued')}
              remedy={t('deliveryStatus')}
            />
            <Link
              href={`/admin/flows/${queued.flowId}`}
              className="text-sm text-teal-700 underline"
            >
              {t('flows')} · <code>{queued.runId}</code>
            </Link>
          </>
        ) : null}
        {preview ? (
          <>
            <p className="text-xs text-slate-500">
              {t('version')}{' '}
              <code className="break-all">{preview.version}</code>
            </p>
            {preview.refusals.map((message) => (
              <SchedulingAlert key={message} message={message} />
            ))}
            <label className="block text-sm">
              {t('recipients')}
              <Select
                aria-label={t('recipients')}
                value={recipientId}
                onChange={(event) => setRecipientId(event.target.value)}
                className="mt-1 w-full rounded border p-2 dark:bg-slate-950"
              >
                {preview.recipients.map((r) => (
                  <option key={r.partyId} value={r.partyId}>
                    {r.name} · {r.email ?? t('missingEmail')} ·{' '}
                    {r.subjects.map((s) => s.name).join(', ')}
                  </option>
                ))}
              </Select>
            </label>
            {report ? (
              <iframe
                title={t('report')}
                srcDoc={report.html}
                sandbox=""
                className="h-96 w-full rounded-lg border bg-white"
              />
            ) : null}
          </>
        ) : null}
        <div className="flex gap-3 text-xs">
          <Link href="/admin/flows" className="text-teal-700 underline">
            {t('flows')}
          </Link>
          {board.board.rowKind === 'resources' ? (
            <Link
              href={`${board.board.projectId ? `/projects/${board.board.projectId}/schedule` : '/scheduling'}/recipients?board=${encodeURIComponent(board.board.code)}`}
              className="text-teal-700 underline"
            >
              {t('contacts')}
            </Link>
          ) : null}
        </div>
      </div>
    </Drawer>
  )
}

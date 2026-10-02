'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations, useFormatter } from 'next-intl'
import {
  Badge,
  Button,
  EmptyState,
  Label,
  Skeleton,
  Textarea,
} from '@openbooks/ui'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ApplicationWorkspace } from '@openbooks/engine/hrm/recruiting'
import {
  DirtyUrlDrawer,
  useDirtyUrlDrawer,
} from '../../../../components/dirty-url-drawer'
import { RecordTabs } from '../../../../components/module-home/record-tabs'
import { readApiErrorMessage } from '../../../../lib/api-error'

type Selection = {
  id: string
  candidate: string
  opening: string
  href: string
}
export function ApplicationReview({
  selection,
  queue,
  closeHref,
  canManage,
}: {
  selection: Selection
  queue: Selection[]
  closeHref: string
  canManage: boolean
}) {
  // Keep the review session's order while decisions refresh the underlying queue.
  const [order] = useState(queue)
  const current = order.find((row) => row.id === selection.id) ?? selection
  return (
    <DirtyUrlDrawer
      open
      openKey={selection.id}
      closeHref={closeHref}
      title={current.candidate}
      description={current.opening}
      size="2xl"
    >
      <ApplicationBody
        key={selection.id}
        selection={current}
        queue={order}
        canManage={canManage}
      />
    </DirtyUrlDrawer>
  )
}
function ApplicationBody({
  selection,
  queue,
  canManage,
}: {
  selection: Selection
  queue: Selection[]
  canManage: boolean
}) {
  const t = useTranslations('hrm.talentWorkspace'),
    hrm = useTranslations('hrm'),
    fmt = useFormatter(),
    router = useRouter()
  const [data, setData] = useState<ApplicationWorkspace | null>(null),
    [pending, setPending] = useState(true),
    [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false),
    [rejecting, setRejecting] = useState(false),
    [reason, setReason] = useState(''),
    [tab, setTab] = useState<'evidence' | 'activity'>('evidence')
  const abort = useRef<AbortController | null>(null)
  const close = useDirtyUrlDrawer(reason.trim().length > 0, busy)
  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      const response = await fetch(
        `/api/hrm/recruiting/applications/${selection.id}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('loadFailed')))
        return
      }
      const result = (await response.json()) as ApplicationWorkspace
      if (result.application?.id !== selection.id) {
        setError(t('loadFailed'))
        return
      }
      setData(result)
      setError(null)
    } catch {
      if (!controller.signal.aborted) setError(t('loadFailed'))
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }, [selection.id, t])
  useEffect(() => {
    // The request synchronizes the drawer with an external record; all state changes follow the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return () => abort.current?.abort()
  }, [load])
  const index = queue.findIndex((row) => row.id === selection.id),
    previous = queue[index - 1],
    next = queue[index + 1]
  const stages = data?.requisition.stages ?? [],
    current = stages.findIndex(
      (stage) => stage.id === data?.application.stageId,
    )
  const nextStage = stages
    .slice(current + 1)
    .find(
      (stage) =>
        !['hired', 'rejected'].includes(stage.kind) &&
        !['hired', 'rejected'].includes(stage.key),
    )
  async function decide(action: 'move' | 'reject') {
    if (!data || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/hrm/recruiting/applications/${selection.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            expectedStageId: data.application.stageId,
            ...(action === 'move' ? { toStageId: nextStage?.id } : { reason }),
          }),
        },
      )
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('saveFailed')))
        return
      }
      const result = (await response.json()) as {
        application?: { id: string; stageId: string; status: string }
      }
      if (result.application?.id !== selection.id) {
        setError(t('saveFailed'))
        return
      }
      setReason('')
      setRejecting(false)
      await load()
      router.refresh()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {index >= 0
            ? t('queuePosition', { position: index + 1, count: queue.length })
            : t('application')}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!previous || busy}
            onClick={() => previous && void close(previous.href)}
          >
            <ChevronLeft size={15} />
            {t('previous')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!next || busy}
            onClick={() => next && void close(next.href)}
          >
            {t('next')}
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
      {error && (
        <EmptyState
          title={t('loadFailed')}
          description={error}
          action={
            <Button
              variant="outline"
              onClick={() => {
                setPending(true)
                setError(null)
                void load()
              }}
              disabled={busy}
            >
              {t('retry')}
            </Button>
          }
        />
      )}
      {pending ? (
        <div aria-busy="true" className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge>{data.application.stageName}</Badge>
              <Badge variant="outline">
                {t(`applicationStatuses.${data.application.status}`)}
              </Badge>
              <span className="text-sm text-slate-500">
                {t('appliedOn', { date: data.application.appliedOn })}
              </span>
            </div>
            <RecordTabs
              label={t('application')}
              active={tab}
              onChange={setTab}
              tabs={[
                { key: 'evidence', label: t('evidence') },
                { key: 'activity', label: t('activity') },
              ]}
            >
              {tab === 'evidence' ? (
                <div className="space-y-5 py-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-slate-500">{t('contact')}</p>
                      <p>{data.candidate.email ?? '—'}</p>
                      <p>{data.candidate.phone ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">{t('source')}</p>
                      <p>{data.candidate.source ?? '—'}</p>
                    </div>
                  </div>
                  {data.candidate.resumeAttachmentId ? (
                    <Button asChild variant="outline">
                      <a
                        href={`/api/hrm/recruiting/applications/${selection.id}/resume`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('openResume')}
                      </a>
                    </Button>
                  ) : (
                    <p className="text-sm text-slate-500">{t('noResume')}</p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/hrm/recruiting?tab=openings&requisition=${data.requisition.id}`}
                      >
                        {t('openingDetails')}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/hrm/recruiting?tab=interviews&candidate=${data.candidate.id}`}
                      >
                        {t('interviews')}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/hrm/recruiting?tab=offers&requisition=${data.requisition.id}`}
                      >
                        {t('offers')}
                      </Link>
                    </Button>
                  </div>
                  {data.candidate.interviews
                    .filter((item) => item.applicationId === selection.id)
                    .map((item) => (
                      <div
                        key={item.id}
                        className="rounded-md border p-3 text-sm"
                      >
                        <Link
                          className="font-medium text-blue-600"
                          href={`/hrm/recruiting?tab=interviews&interview=${item.id}`}
                        >
                          {item.kind} ·{' '}
                          {fmt.dateTime(new Date(item.scheduledAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </Link>
                        <p>{t(`interviewStatuses.${item.status}`)}</p>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="space-y-3 py-4">
                  {data.events.length ? (
                    data.events.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-md border p-3 text-sm"
                      >
                        <p className="font-medium">
                          {hrm.has(`recruiting.eventKind.${event.kind}`)
                            ? hrm(`recruiting.eventKind.${event.kind}`)
                            : event.kind.replaceAll('_', ' ')}
                        </p>
                        <p>
                          {[event.fromStage, event.toStage]
                            .filter(Boolean)
                            .join(' → ')}
                        </p>
                        {event.reason && (
                          <p className="whitespace-pre-wrap">{event.reason}</p>
                        )}
                        <p className="text-xs text-slate-500">
                          {fmt.dateTime(new Date(event.at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">{t('noHistory')}</p>
                  )}
                </div>
              )}
            </RecordTabs>
            {canManage && data.application.status === 'active' && (
              <div className="space-y-3 border-t pt-4">
                {rejecting ? (
                  <div className="space-y-2">
                    <Label htmlFor="rejection-reason">
                      {t('rejectionReason')}
                    </Label>
                    <Textarea
                      id="rejection-reason"
                      autoFocus
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={2000}
                      disabled={busy}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        disabled={busy || !reason.trim()}
                        onClick={() => void decide('reject')}
                      >
                        {t('confirmReject')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setReason('')
                          setRejecting(false)
                        }}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {nextStage && (
                      <Button
                        disabled={busy}
                        onClick={() => void decide('move')}
                      >
                        {t('advanceTo', { stage: nextStage.name })}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRejecting(true)}
                    >
                      {t('reject')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  )
}

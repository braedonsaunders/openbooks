'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronLeft, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { InsightQuery, VizSettings, VizType } from '@openbooks/analytics'
import { Badge, Button, Input, Label, PageHeader, Select } from '@openbooks/ui'
import { DetailPageLayout } from '../../../../../components/page-layout'
import { CardTile, type CardTileData } from '../../CardTile'

type Widget = { cardId: string; x: number; y: number; w: number; h: number }
type EmbedCard = {
  id: string
  name: string
  description: string | null
  query: unknown
  viz_type: VizType
  viz_settings: VizSettings
}
type AvailableCard = { id: string; name: string; description: string | null; viz_type: VizType }

// Message keys (under the `insights` namespace) — translated at the render site.
const WIDTHS = [
  { value: 4, labelKey: 'builder.widths.third' },
  { value: 6, labelKey: 'builder.widths.half' },
  { value: 8, labelKey: 'builder.widths.twoThirds' },
  { value: 12, labelKey: 'builder.widths.full' },
]
const HEIGHTS = [
  { value: 4, labelKey: 'builder.heights.short' },
  { value: 6, labelKey: 'builder.heights.medium' },
  { value: 8, labelKey: 'builder.heights.tall' },
]
// Sentinel persisted to the DB for unnamed dashboards — stored data, never
// translated. The page title shows the localized `builder.untitled` instead.
const UNTITLED_DASHBOARD = 'Untitled dashboard'

export function DashboardBuilder({
  dashboard,
  cards,
  availableCards,
  pinned,
  canCreate,
  canPublish,
}: {
  dashboard: {
    id: string
    name: string
    description: string | null
    status: 'draft' | 'published'
    layout: Widget[]
    /** Optional for server-rendered callers; the API bootstrap fills it when absent. */
    updated_at?: string
  }
  cards: EmbedCard[]
  availableCards: AvailableCard[]
  pinned: boolean
  canCreate: boolean
  canPublish: boolean
}) {
  const t = useTranslations('insights')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const ro = !canCreate

  const [name, setName] = useState(dashboard.name === UNTITLED_DASHBOARD ? '' : dashboard.name)
  const [description, setDescription] = useState(dashboard.description ?? '')
  const [layout, setLayout] = useState<Widget[]>(dashboard.layout)
  const [status, setStatus] = useState(dashboard.status)
  const [isPinned, setIsPinned] = useState(pinned)
  const [busy, setBusy] = useState(false)

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const placedIds = new Set(layout.map((w) => w.cardId))
  const addable = availableCards.filter((c) => !placedIds.has(c.id))

  // -- autosave (name/description/layout) -----------------------------------
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const payload = useMemo(
    () => ({ name: name.trim() || UNTITLED_DASHBOARD, description: description.trim() || null, layout }),
    [name, description, layout],
  )

  // Saves are serialized locally and fenced remotely. A request that has
  // already reached the server cannot be cancelled reliably, so the latest
  // payload waits for it to return and then uses the fresh revision token. This
  // preserves rapid-edit/latest-wins semantics without allowing an old response
  // to mark a newer draft as saved.
  const revisionRef = useRef<string | null>(dashboard.updated_at ?? null)
  const pendingSaveRef = useRef<{
    payload: typeof payload
    sequence: number
  } | null>(null)
  const saveSequenceRef = useRef(0)
  const saveRunningRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushSave = async () => {
    if (saveRunningRef.current) return
    const pending = pendingSaveRef.current
    if (!pending) return
    pendingSaveRef.current = null
    saveRunningRef.current = true

    try {
      // The detail page does not need to carry a revision prop: bootstrap it
      // from the exact-token GET before the first write when necessary.
      if (!revisionRef.current) {
        const current = await fetch(`/api/insights/dashboards/${dashboard.id}`)
        const currentData = (await current.json().catch(() => ({}))) as {
          updated_at?: unknown
        }
        if (!current.ok || typeof currentData.updated_at !== 'string') {
          throw new Error(t('autosave.failed'))
        }
        revisionRef.current = currentData.updated_at
      }

      const res = await fetch(`/api/insights/dashboards/${dashboard.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...pending.payload,
          expectedUpdatedAt: revisionRef.current,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: unknown
        updated_at?: unknown
      }
      if (!res.ok) {
        if (pending.sequence === saveSequenceRef.current && pendingSaveRef.current === null) {
          setSaveState('error')
          toast.error(typeof data.error === 'string' ? data.error : t('autosave.failed'))
        }
        return
      }

      if (typeof data.updated_at !== 'string') throw new Error(t('autosave.failed'))
      revisionRef.current = data.updated_at
      // An intermediate response must not overwrite the UI state of a newer
      // edit. The queued latest payload will be flushed in finally below.
      if (pending.sequence === saveSequenceRef.current && pendingSaveRef.current === null) {
        setSaveState('saved')
        router.refresh()
      }
    } catch (error) {
      if (pending.sequence === saveSequenceRef.current && pendingSaveRef.current === null) {
        setSaveState('error')
        toast.error(error instanceof Error ? error.message : t('autosave.failed'))
      }
    } finally {
      saveRunningRef.current = false
      if (pendingSaveRef.current) void flushSave()
    }
  }

  const first = useRef(true)
  useEffect(() => {
    if (ro) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const sequence = ++saveSequenceRef.current
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      pendingSaveRef.current = { payload, sequence }
      setSaveState('saving')
      void flushSave()
    }, 600)
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, ro])

  function addCard(cardId: string) {
    // Stack new cards at the bottom, half width by default.
    const nextY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0)
    setLayout([...layout, { cardId, x: 0, y: nextY, w: 6, h: 6 }])
  }
  function removeCard(i: number) {
    setLayout(layout.filter((_, j) => j !== i))
  }
  function updateWidget(i: number, patch: Partial<Widget>) {
    setLayout(layout.map((w, j) => (j === i ? { ...w, ...patch } : w)))
  }

  const nameValid = name.trim().length > 0

  async function setPublished(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/insights/dashboards/${dashboard.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('errors.updateFailed'))
    else {
      setStatus(next ? 'published' : 'draft')
      toast.success(next ? t('builder.publishedToast') : t('builder.draftToast'))
    }
    setBusy(false)
    router.refresh()
  }

  async function togglePin() {
    setBusy(true)
    const res = await fetch(`/api/insights/dashboards/${dashboard.id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: !isPinned }),
    })
    if (res.ok) {
      setIsPinned(!isPinned)
      toast.success(!isPinned ? t('builder.pinnedToast') : t('builder.unpinnedToast'))
    } else toast.error(t('builder.pinFailed'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (!confirm(t('builder.deleteConfirm'))) return
    setBusy(true)
    const res = await fetch(`/api/insights/dashboards/${dashboard.id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error(t('builder.deleteFailed'))
      setBusy(false)
      return
    }
    toast.success(t('builder.deletedToast'))
    router.push('/insights/dashboards')
    router.refresh()
  }

  return (
    <DetailPageLayout
      header={
        <div className="space-y-3">
          <Link
            href="/insights/dashboards"
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ChevronLeft size={15} /> {t('builder.back')}
          </Link>
          <PageHeader
            title={name.trim() || t('builder.untitled')}
            actions={
              <div className="flex items-center gap-2">
                <Badge variant={status === 'published' ? 'success' : 'outline'}>
                  {status === 'published' ? t('status.published') : tCommon('status.draft')}
                </Badge>
                <Button variant="outline" size="sm" disabled={busy} onClick={togglePin}>
                  {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  {isPinned ? t('builder.unpin') : t('builder.pinToHome')}
                </Button>
                {canCreate ? (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
                    <Trash2 size={14} /> {tCommon('actions.delete')}
                  </Button>
                ) : null}
                {canPublish ? (
                  status === 'published' ? (
                    <Button variant="outline" disabled={busy} onClick={() => setPublished(false)}>
                      {t('actions.unpublish')}
                    </Button>
                  ) : (
                    <Button disabled={busy || !nameValid} onClick={() => setPublished(true)}>
                      {t('actions.publish')}
                    </Button>
                  )
                ) : null}
              </div>
            }
          />
          {canCreate ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto]">
              <div className="space-y-1.5">
                <Label>{tCommon('labels.name')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('builder.namePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{tCommon('labels.description')}</Label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tCommon('labels.optional')} />
              </div>
              <div className="flex items-end pb-1 text-xs text-slate-500 dark:text-slate-400">
                {saveState === 'saved'
                  ? t('autosave.saved')
                  : saveState === 'saving'
                    ? tCommon('actions.saving')
                    : saveState === 'error'
                      ? tCommon('feedback.saveFailed')
                      : t('autosave.unsaved')}
              </div>
            </div>
          ) : null}
        </div>
      }
    >
      {canCreate && addable.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t('builder.addCard')}</span>
          <div className="flex flex-wrap gap-2">
            {addable.map((c) => (
              <Button key={c.id} variant="outline" size="sm" onClick={() => addCard(c.id)}>
                <Plus size={13} /> {c.name}
              </Button>
            ))}
          </div>
        </div>
      ) : canCreate && availableCards.length === 0 ? (
        <div className="mb-4 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {t.rich('builder.noPublishedCards', {
            link: (chunks) => (
              <Link href="/insights" className="text-teal-700 hover:underline dark:text-teal-300">
                {chunks}
              </Link>
            ),
          })}
        </div>
      ) : null}

      {layout.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {canCreate ? t('builder.emptyEditor') : t('empty.dashboardNoCards')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {layout.map((w, i) => {
            const card = cardById.get(w.cardId)
            const span = Math.max(1, Math.min(12, w.w))
            return (
              <div
                key={`${w.cardId}-${i}`}
                className="md:[grid-column:span_var(--span)]"
                style={{ ['--span' as string]: String(span), minHeight: `${Math.max(2, w.h) * 3.25}rem` }}
              >
                {card ? (
                  <CardTile
                    card={
                      {
                        id: card.id,
                        name: card.name,
                        description: card.description,
                        query: card.query as InsightQuery,
                        vizType: card.viz_type,
                        vizSettings: card.viz_settings ?? {},
                      } satisfies CardTileData
                    }
                    header={
                      !ro ? (
                        <div className="flex items-center gap-1">
                          <Select
                            value={w.w}
                            onChange={(e) => updateWidget(i, { w: Number(e.target.value) })}
                            className="h-7 w-24 py-0 text-xs"
                            aria-label={t('builder.cardWidth')}
                          >
                            {WIDTHS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                              </option>
                            ))}
                          </Select>
                          <Select
                            value={w.h}
                            onChange={(e) => updateWidget(i, { h: Number(e.target.value) })}
                            className="h-7 w-20 py-0 text-xs"
                            aria-label={t('builder.cardHeight')}
                          >
                            {HEIGHTS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                              </option>
                            ))}
                          </Select>
                          <Button variant="ghost" size="sm" aria-label={t('builder.removeCard')} onClick={() => removeCard(i)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="flex h-full min-h-[8rem] items-center justify-between rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    <span>{t('builder.unavailableCard')}</span>
                    {!ro ? (
                      <Button variant="ghost" size="sm" onClick={() => removeCard(i)}>
                        {tCommon('actions.remove')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </DetailPageLayout>
  )
}

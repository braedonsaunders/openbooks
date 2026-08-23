'use client'

import 'react-grid-layout/css/styles.css'
import './_grid-overrides.css'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Loader2, Plus, RotateCcw, Save, Settings, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { toast } from 'sonner'
import { confirmDialog } from '@/lib/confirm'
import type { Layout, LayoutItem } from 'react-grid-layout'
import type { DashboardLayoutData } from '@openbooks/schema'
import { WIDGETS, type WidgetMeta } from './_widget-registry'
import type { RoleTier } from './_role-tier'
import { QuickActions } from './_quick-actions'
import type { SaveQuickActionsAction } from './_quick-actions-shared'
import { WidgetPalette } from './_widget-palette'
import { resetDashboardLayout, saveDashboardLayout } from './actions'
import { isUuid } from '@/lib/list-params'
import { appWidgetId, isAppWidgetId } from '@/lib/apps/surfaces'
import type { DashboardApp } from './_app-widget'

const Responsive = dynamic(() => import('react-grid-layout').then((m) => m.Responsive), {
  ssr: false,
}) as unknown as React.ComponentType<any>

const COLS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 }
// react-grid-layout measures the content pane, not the browser viewport. With
// the expanded sidebar a 1280px desktop has a ~980px grid, so a 996px `md`
// cutoff incorrectly collapsed four KPI cards into a two-column stack. The
// component already has dedicated tablet/phone rendering at <=1023 viewport
// pixels; keep the measured desktop pane on the 12-column layout.
const BREAKPOINTS = { lg: 1200, md: 768, sm: 640, xs: 480, xxs: 0 }
const ROW_HEIGHT = 48
const MARGIN: readonly [number, number] = [16, 16]
const RESIZE_HANDLES = ['se'] as const
type LayoutWidget = DashboardLayoutData['widgets'][number]
type LibraryCard = { id: string; name: string; description: string }
type DashboardGridActionResult = { ok: true } | { ok: false; error?: string }
type SaveDashboardGridAction = (input: { widgets: LayoutWidget[] }) => Promise<DashboardGridActionResult>
type ResetDashboardGridAction = () => Promise<DashboardGridActionResult>

function quickActionsStateKey(actions: DashboardLayoutData['quickActions']): string {
  return actions ? JSON.stringify(actions) : 'default'
}

export function DashboardGrid({
  initialLayout,
  nodes,
  role,
  mode,
  libraryCards = [],
  apps = [],
  allowedWidgetIds,
  saveLayoutAction = saveDashboardLayout as SaveDashboardGridAction,
  resetLayoutAction = resetDashboardLayout as ResetDashboardGridAction,
  saveRedirectHref = '/',
  quickActionsSaveAction,
  hiddenQuickActionIds,
}: {
  initialLayout: DashboardLayoutData
  nodes: Record<string, ReactNode>
  role: RoleTier
  mode: 'view' | 'edit'
  libraryCards?: LibraryCard[]
  apps?: DashboardApp[]
  allowedWidgetIds?: readonly string[] | Set<string>
  saveLayoutAction?: SaveDashboardGridAction
  resetLayoutAction?: ResetDashboardGridAction
  saveRedirectHref?: string
  quickActionsSaveAction?: SaveQuickActionsAction
  hiddenQuickActionIds?: readonly string[]
}) {
  const t = useTranslations('dashboard')
  const cardNameById = useMemo(
    () => new Map(libraryCards.map((c) => [c.id, c.name])),
    [libraryCards],
  )
  const router = useRouter()
  const [width, setWidth] = useState(1024)
  const [viewport, setViewport] = useState<'phone' | 'tablet' | 'desktop'>('desktop')
  const [layout, setLayout] = useState<LayoutWidget[]>(initialLayout.widgets)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialLayout.widgets))
  const dirty = useMemo(() => JSON.stringify(layout) !== baseline, [baseline, layout])

  useLayoutEffect(() => {
    const phone = window.matchMedia('(max-width: 639px)')
    const tablet = window.matchMedia('(max-width: 1023px)')
    const apply = () => setViewport(phone.matches ? 'phone' : tablet.matches ? 'tablet' : 'desktop')
    apply()
    phone.addEventListener('change', apply)
    tablet.addEventListener('change', apply)
    return () => {
      phone.removeEventListener('change', apply)
      tablet.removeEventListener('change', apply)
    }
  }, [])

  const roRef = useRef<ResizeObserver | null>(null)
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const next = Math.floor(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    ro.observe(el)
    roRef.current = ro
  }, [])

  useEffect(() => {
    if (!paletteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

  const rglLayout = useMemo<LayoutItem[]>(
    () =>
      layout.map((w) => {
        const meta = WIDGETS[w.id]
        const appWidget = isAppWidgetId(w.id)
        return {
          i: w.id,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: meta?.minSize.w ?? (appWidget ? 3 : 2),
          minH: meta?.minSize.h ?? 2,
          maxW: meta?.maxSize?.w,
          maxH: meta?.maxSize?.h,
          isDraggable: mode === 'edit',
          isResizable: mode === 'edit',
        }
      }),
    [layout, mode],
  )

  const presentIds = useMemo(() => new Set(layout.map((w) => w.id)), [layout])

  const handleAdd = useCallback(
    (meta: WidgetMeta) => {
      if (presentIds.has(meta.id)) return
      const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0)
      setLayout((prev) => [
        ...prev,
        { id: meta.id, x: 0, y: maxY, w: meta.defaultSize.w, h: meta.defaultSize.h },
      ])
    },
    [layout, presentIds],
  )

  const handleAddCard = useCallback(
    (card: { id: string }) => {
      if (presentIds.has(card.id)) return
      const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0)
      setLayout((prev) => [...prev, { id: card.id, x: 0, y: maxY, w: 4, h: 4 }])
    },
    [layout, presentIds],
  )

  const handleAddApp = useCallback(
    (app: DashboardApp) => {
      const id = appWidgetId(app.key)
      if (presentIds.has(id)) return
      const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0)
      setLayout((prev) => [...prev, { id, x: 0, y: maxY, w: 4, h: 3 }])
    },
    [layout, presentIds],
  )

  const handleRemove = useCallback((id: string) => {
    setLayout((prev) => prev.filter((w) => w.id !== id))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await saveLayoutAction({ widgets: layout })
      if (res.ok) {
        setBaseline(JSON.stringify(layout))
        toast.success(t('grid.saved'))
        router.push(saveRedirectHref)
      } else {
        toast.error(res.error ?? t('grid.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }, [layout, router, saveLayoutAction, saveRedirectHref, t])

  const handleReset = useCallback(async () => {
    if (!(await confirmDialog({ message: t('grid.resetConfirm'), tone: 'danger' }))) return
    setResetting(true)
    try {
      const res = await resetLayoutAction()
      if (res.ok) {
        toast.success(t('grid.resetDone'))
        router.refresh()
      } else {
        toast.error(res.error ?? t('grid.resetFailed'))
      }
    } finally {
      setResetting(false)
    }
  }, [resetLayoutAction, router, t])

  const commitLayout = useCallback(
    (next: Layout) => {
      if (mode !== 'edit') return
      setLayout((prev) => {
        const map = new Map(prev.map((w) => [w.id, w]))
        const updated: LayoutWidget[] = []
        for (const item of next) {
          if (!map.has(item.i)) continue
          updated.push({ id: item.i, x: item.x, y: item.y, w: item.w, h: item.h })
        }
        return updated
      })
    },
    [mode],
  )

  const nodeFor = (id: string) =>
    id === 'personal-actions' && quickActionsSaveAction ? (
      <QuickActions
        key={quickActionsStateKey(initialLayout.quickActions)}
        actions={initialLayout.quickActions}
        saveAction={quickActionsSaveAction}
        hiddenActionIds={hiddenQuickActionIds}
      />
    ) : (
      nodes[id]
    )

  if (mode === 'view' && viewport !== 'desktop') {
    const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x)
    if (viewport === 'phone') {
      return (
        <div className="space-y-4">
          {ordered.map((w) => (
            <div key={w.id}>{nodeFor(w.id) ?? null}</div>
          ))}
        </div>
      )
    }
    return (
      <div className="columns-2 gap-4">
        {ordered.map((w) => (
          <div key={w.id} className="mb-4 break-inside-avoid">
            {nodeFor(w.id) ?? null}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {mode === 'edit' ? (
        <EditToolbar
          dirty={dirty}
          saving={saving}
          resetting={resetting}
          onSave={handleSave}
          onReset={handleReset}
          onTogglePalette={() => setPaletteOpen((v) => !v)}
          paletteOpen={paletteOpen}
        />
      ) : null}

      <div className="w-full">
        <div ref={measureRef} className="min-w-0">
          <Responsive
            className="layout"
            width={width}
            layouts={{ lg: rglLayout, md: rglLayout, sm: rglLayout, xs: rglLayout, xxs: rglLayout }}
            cols={COLS}
            breakpoints={BREAKPOINTS}
            rowHeight={ROW_HEIGHT}
            margin={MARGIN}
            containerPadding={[0, 0]}
            dragConfig={{
              enabled: mode === 'edit',
              bounded: false,
              cancel: '.no-drag,button,input,select,textarea',
              threshold: 3,
            }}
            resizeConfig={{
              enabled: mode === 'edit',
              handles: RESIZE_HANDLES,
            }}
            onDragStop={(next: Layout) => commitLayout(next)}
            onResizeStop={(next: Layout) => commitLayout(next)}
          >
            {layout.map((w) => {
              const node = nodeFor(w.id)
              return (
                <div key={w.id} className="group/cell">
                  <div
                    className="relative h-full w-full"
                    onClickCapture={
                      mode === 'edit'
                        ? (e) => {
                            if (!(e.target as HTMLElement).closest('a')) return
                            e.preventDefault()
                            e.stopPropagation()
                          }
                        : undefined
                    }
                  >
                    {mode === 'edit' ? (
                      <>
                        <div className="ring-dashed pointer-events-none absolute inset-0 z-10 rounded-xl ring-1 ring-teal-300/0 transition group-hover/cell:ring-teal-400/80" />
                        <button
                          type="button"
                          onClick={() => handleRemove(w.id)}
                          aria-label={t('grid.remove')}
                          className="no-drag absolute -top-2 -right-2 z-20 inline-flex h-6 w-6 items-center justify-center rounded-full border border-rose-200 bg-white text-rose-600 opacity-0 shadow-sm transition group-hover/cell:opacity-100 hover:bg-rose-50 dark:border-rose-800/60 dark:bg-slate-900 dark:hover:bg-rose-950/40"
                        >
                          <X size={12} />
                        </button>
                      </>
                    ) : null}
                    {node ??
                      (isUuid(w.id) ? (
                        <div className="flex h-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-teal-200 bg-teal-50/40 px-3 text-center dark:border-teal-800/50 dark:bg-teal-950/30">
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
                            {cardNameById.get(w.id) ?? t('grid.cardMissing')}
                          </span>
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                          {t('grid.unknownWidget', { id: w.id })}
                        </div>
                      ))}
                  </div>
                </div>
              )
            })}
          </Responsive>
        </div>

        {mode === 'edit' && paletteOpen ? (
          <WidgetPalette
            role={role}
            presentIds={presentIds}
            onAdd={handleAdd}
            libraryCards={libraryCards}
            onAddCard={handleAddCard}
            apps={apps}
            onAddApp={handleAddApp}
            allowedWidgetIds={allowedWidgetIds}
            onClose={() => setPaletteOpen(false)}
          />
        ) : null}
      </div>
    </div>
  )
}

function EditToolbar({
  dirty,
  saving,
  resetting,
  onSave,
  onReset,
  onTogglePalette,
  paletteOpen,
}: {
  dirty: boolean
  saving: boolean
  resetting: boolean
  onSave: () => void
  onReset: () => void
  onTogglePalette: () => void
  paletteOpen: boolean
}) {
  const t = useTranslations('dashboard')
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="sticky top-0 z-40 flex items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-2.5 backdrop-blur dark:border-teal-800/60 dark:bg-teal-950/50"
    >
      <div className="flex items-center gap-2 text-sm">
        <Settings size={14} className="text-teal-700 dark:text-teal-300" />
        <span className="font-semibold text-teal-900 dark:text-teal-300">
          {t('grid.customizing')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={onTogglePalette} className="h-8 text-xs">
          <Plus size={13} className="mr-1" />
          {paletteOpen ? t('grid.closePalette') : t('grid.addWidget')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onReset}
          disabled={resetting}
          className="h-8 text-xs text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40"
        >
          {resetting ? <Loader2 size={13} className="mr-1 animate-spin" /> : <RotateCcw size={13} className="mr-1" />}
          {t('grid.reset')}
        </Button>
        <Button type="button" onClick={onSave} disabled={saving || !dirty} className="h-8 text-xs">
          {saving ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Save size={13} className="mr-1" />}
          {t('grid.save')}
        </Button>
      </div>
    </motion.div>
  )
}

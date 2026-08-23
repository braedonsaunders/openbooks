'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronUp, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input } from '@openbooks/ui'
import {
  MAX_QUICK_ACTIONS,
  TONE_KEYS,
  TONES,
  toneOf,
  visibleQuickActions,
  type QuickAction,
  type QuickActionOption,
  type QuickActionOptions,
  type SaveQuickActionsAction,
} from './_quick-actions-shared'
import { FALLBACK_ICON, ICON_PICKER_KEYS, QUICK_ACTION_ICONS } from './_quick-actions-icons'
import { listQuickActionOptions, saveQuickActions } from './actions'

type View = 'list' | 'picker' | 'edit'
type PickerTab = 'common' | 'custom'

function genId(): string {
  return globalThis.crypto.randomUUID()
}

export function QuickActionsEditor({
  open,
  value,
  hiddenActionIds,
  onClose,
  onSaved,
  saveAction = saveQuickActions,
}: {
  open: boolean
  value: QuickAction[]
  hiddenActionIds?: readonly string[]
  onClose: () => void
  onSaved: (next: QuickAction[]) => void
  saveAction?: SaveQuickActionsAction
}) {
  const t = useTranslations('dashboard')
  const router = useRouter()
  const [items, setItems] = useState<QuickAction[]>(value)
  const [view, setView] = useState<View>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [options, setOptions] = useState<QuickActionOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickerTab, setPickerTab] = useState<PickerTab>('common')
  const [search, setSearch] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [customHref, setCustomHref] = useState('')

  function reset(nextItems: QuickAction[]) {
    setItems(nextItems.map((a) => ({ ...a })))
    setView('list')
    setEditingId(null)
    setSearch('')
    setPickerTab('common')
    setCustomLabel('')
    setCustomHref('')
  }

  function close() {
    reset(value)
    onClose()
  }

  useEffect(() => {
    if (!open || options) return
    let cancelled = false
    listQuickActionOptions()
      .then((nextOptions) => {
        if (!cancelled) setOptions(nextOptions)
      })
      .catch(() => {
        if (!cancelled) toast.error(t('quickActions.editor.loadFailed'))
      })
    return () => { cancelled = true }
  }, [open, options, t])

  const loadingOptions = open && !options
  const hidden = new Set(hiddenActionIds)
  const visibleItems = visibleQuickActions(items, hidden)
  const editing = editingId ? items.find((a) => a.id === editingId) : null

  function patch(id: string, changes: Partial<QuickAction>) {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...changes } : a)))
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((a) => a.id !== id))
  }

  function move(id: string, dir: -1 | 1) {
    setItems((prev) => {
      const i = prev.findIndex((a) => a.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }

  function addFromOption(opt: QuickActionOption) {
    if (items.length >= MAX_QUICK_ACTIONS) {
      toast.error(t('quickActions.editor.maxReached', { count: MAX_QUICK_ACTIONS }))
      return
    }
    setItems((prev) => [
      ...prev,
      { id: genId(), label: opt.label, href: opt.href, iconKey: opt.iconKey, tone: opt.tone },
    ])
    setView('list')
    setSearch('')
  }

  function addCustom() {
    const label = customLabel.trim()
    const href = customHref.trim()
    if (!label || !href) return
    // Mirrors safeHref in _quick-actions-input.ts — '//' would be protocol-relative.
    if (!((href.startsWith('/') && !href.startsWith('//')) || /^https?:\/\//i.test(href))) {
      toast.error(t('quickActions.editor.invalidUrl'))
      return
    }
    if (items.length >= MAX_QUICK_ACTIONS) {
      toast.error(t('quickActions.editor.maxReached', { count: MAX_QUICK_ACTIONS }))
      return
    }
    setItems((prev) => [...prev, { id: genId(), label, href, iconKey: 'link', tone: 'sky' }])
    setCustomLabel('')
    setCustomHref('')
    setView('list')
  }

  async function handleSave() {
    const clean = items
      .map((a) => ({ ...a, label: a.label.trim(), href: a.href.trim() }))
      .filter((a) => a.label && a.href)
    setSaving(true)
    try {
      const res = await saveAction(clean)
      if (res.ok) {
        toast.success(t('quickActions.editor.saved'))
        onSaved(clean)
        router.refresh()
        reset(clean)
        onClose()
      } else {
        toast.error(res.error ?? t('quickActions.editor.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const title =
    view === 'picker'
      ? t('quickActions.editor.addAction')
      : view === 'edit'
        ? t('quickActions.editor.edit')
        : t('quickActions.editor.title')

  return (
    <Drawer
      open={open}
      onClose={close}
      size="md"
      title={title}
      description={view === 'list' ? t('quickActions.editor.description') : undefined}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            {t('quickActions.editor.cancel')}
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
            {t('quickActions.editor.save')}
          </Button>
        </>
      }
    >
      {view === 'list' ? (
        <ListView
          items={visibleItems}
          storedCount={items.length}
          onAdd={() => setView('picker')}
          onEdit={(id) => { setEditingId(id); setView('edit') }}
          onRemove={remove}
          onMove={move}
        />
      ) : view === 'picker' ? (
        <PickerView
          tab={pickerTab}
          setTab={setPickerTab}
          search={search}
          setSearch={setSearch}
          options={options}
          loading={loadingOptions}
          customLabel={customLabel}
          customHref={customHref}
          setCustomLabel={setCustomLabel}
          setCustomHref={setCustomHref}
          onAddOption={addFromOption}
          onAddCustom={addCustom}
          onBack={() => setView('list')}
        />
      ) : editing ? (
        <EditView
          action={editing}
          onPatch={(c) => patch(editing.id, c)}
          onBack={() => setView('list')}
        />
      ) : null}
    </Drawer>
  )
}

function ListView({
  items,
  storedCount,
  onAdd,
  onEdit,
  onRemove,
  onMove,
}: {
  items: QuickAction[]
  storedCount: number
  onAdd: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
}) {
  const t = useTranslations('dashboard')
  const atMax = storedCount >= MAX_QUICK_ACTIONS
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((a, i) => {
          const tc = toneOf(a.tone)
          const Icon = QUICK_ACTION_ICONS[a.iconKey] ?? FALLBACK_ICON
          return (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900/60"
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => onMove(a.id, -1)}
                  className="rounded p-0.5 text-slate-400 transition hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === items.length - 1}
                  onClick={() => onMove(a.id, 1)}
                  className="rounded p-0.5 text-slate-400 transition hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                >
                  <ChevronDown size={15} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => onEdit(a.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tc.chip}`}>
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {a.label || t('quickActions.editor.unnamed')}
                  </span>
                  <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                    {a.href}
                  </span>
                </span>
              </button>
              <span className={`h-3 w-3 shrink-0 rounded-full ${tc.swatch}`} aria-hidden />
              <button
                type="button"
                aria-label="Remove"
                onClick={() => onRemove(a.id)}
                className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
              >
                <Trash2 size={15} />
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={onAdd}
        disabled={atMax}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:border-teal-300 hover:bg-teal-50/50 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:border-teal-800/60 dark:hover:bg-teal-950/30 dark:hover:text-teal-300"
      >
        <Plus size={15} />
        {atMax
          ? t('quickActions.editor.maxReached', { count: MAX_QUICK_ACTIONS })
          : t('quickActions.editor.addAction')}
      </button>
    </div>
  )
}

function PickerView({
  tab,
  setTab,
  search,
  setSearch,
  options,
  loading,
  customLabel,
  customHref,
  setCustomLabel,
  setCustomHref,
  onAddOption,
  onAddCustom,
  onBack,
}: {
  tab: PickerTab
  setTab: (t: PickerTab) => void
  search: string
  setSearch: (s: string) => void
  options: QuickActionOptions | null
  loading: boolean
  customLabel: string
  customHref: string
  setCustomLabel: (s: string) => void
  setCustomHref: (s: string) => void
  onAddOption: (o: QuickActionOption) => void
  onAddCustom: () => void
  onBack: () => void
}) {
  const t = useTranslations('dashboard')
  const tabs: { key: PickerTab; label: string }[] = [
    { key: 'common', label: t('quickActions.editor.common') },
    { key: 'custom', label: t('quickActions.editor.customUrl') },
  ]
  const list = tab === 'common' ? (options?.common ?? []) : []
  const q = search.trim().toLowerCase()
  const filtered = q
    ? list.filter((o) => o.label.toLowerCase().includes(q) || o.href.toLowerCase().includes(q))
    : list

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
      >
        <ArrowLeft size={13} />
        {t('quickActions.editor.back')}
      </button>

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/60">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setTab(tb.key)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${
              tab === tb.key
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'custom' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {t('quickActions.editor.label')}
            </label>
            <Input
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder={t('quickActions.editor.labelPlaceholder')}
              maxLength={80}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {t('quickActions.editor.link')}
            </label>
            <Input
              value={customHref}
              onChange={(e) => setCustomHref(e.target.value)}
              placeholder="/ar"
            />
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              {t('quickActions.editor.linkHint')}
            </p>
          </div>
          <Button
            type="button"
            onClick={onAddCustom}
            disabled={!customLabel.trim() || !customHref.trim()}
            className="w-full"
          >
            <Plus size={14} className="mr-1.5" />
            {t('quickActions.editor.addAction')}
          </Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('quickActions.editor.searchPlaceholder')}
              className="pl-8"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              {t('quickActions.editor.loading')}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
              {t('quickActions.editor.noResults')}
            </p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((o) => {
                const tc = toneOf(o.tone)
                const Icon = QUICK_ACTION_ICONS[o.iconKey] ?? FALLBACK_ICON
                return (
                  <li key={`${o.href}:${o.label}`}>
                    <button
                      type="button"
                      onClick={() => onAddOption(o)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-teal-200 hover:bg-teal-50/50 dark:hover:border-teal-800/60 dark:hover:bg-teal-950/30"
                    >
                      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tc.chip}`}>
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                          {o.label}
                        </span>
                        <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                          {o.href}
                        </span>
                      </span>
                      {o.hint ? (
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {o.hint}
                        </span>
                      ) : null}
                      <Plus size={15} className="shrink-0 text-teal-600 dark:text-teal-400" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function EditView({
  action,
  onPatch,
  onBack,
}: {
  action: QuickAction
  onPatch: (changes: Partial<QuickAction>) => void
  onBack: () => void
}) {
  const t = useTranslations('dashboard')
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
      >
        <ArrowLeft size={13} />
        {t('quickActions.editor.back')}
      </button>

      <ActionPreview action={action} />

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('quickActions.editor.label')}
        </label>
        <Input
          value={action.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder={t('quickActions.editor.labelPlaceholder')}
          maxLength={80}
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('quickActions.editor.link')}
        </label>
        <Input
          value={action.href}
          onChange={(e) => onPatch({ href: e.target.value })}
          placeholder="/ar"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('quickActions.editor.icon')}
        </label>
        <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-9">
          {ICON_PICKER_KEYS.map((key) => {
            const Icon = QUICK_ACTION_ICONS[key]!
            const active = action.iconKey === key
            return (
              <button
                key={key}
                type="button"
                aria-label={key}
                onClick={() => onPatch({ iconKey: key })}
                className={`flex aspect-square items-center justify-center rounded-lg border transition ${
                  active
                    ? 'border-teal-400 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800/60'
                }`}
              >
                <Icon size={16} />
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('quickActions.editor.color')}
        </label>
        <div className="flex flex-wrap gap-2">
          {TONE_KEYS.map((tone) => {
            const active = action.tone === tone
            return (
              <button
                key={tone}
                type="button"
                aria-label={TONES[tone].name}
                title={TONES[tone].name}
                onClick={() => onPatch({ tone })}
                className={`h-7 w-7 rounded-full ${TONES[tone].swatch} ring-2 ring-offset-2 transition dark:ring-offset-slate-900 ${
                  active ? 'ring-slate-900 dark:ring-white' : 'ring-transparent'
                }`}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ActionPreview({ action }: { action: QuickAction }) {
  const t = useTranslations('dashboard')
  const tc = toneOf(action.tone)
  const Icon = QUICK_ACTION_ICONS[action.iconKey] ?? FALLBACK_ICON
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/40">
      <p className="mb-2 text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
        {t('quickActions.editor.preview')}
      </p>
      <div
        className={`group flex w-full max-w-[16rem] items-center gap-2.5 rounded-xl border px-3 py-2 shadow-sm ${tc.tile}`}
      >
        <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tc.chip}`}>
          <Icon size={14} />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${tc.label}`}>
          {action.label || t('quickActions.editor.unnamed')}
        </span>
      </div>
    </div>
  )
}

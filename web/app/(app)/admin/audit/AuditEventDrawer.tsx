'use client'

import { useMemo, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Badge, UrlDrawer, cn } from '@openbooks/ui'
import { Braces, Clock3, Database, Fingerprint, History, UserRound } from 'lucide-react'

export type AuditEvent = {
  id: string
  rowId: string
  at: string
  actorName: string | null
  action: string
  recordType: string
  requestId: string | null
  changes: unknown
}

type JsonObject = Record<string, unknown>
type DrawerTab = 'changes' | 'before' | 'after'
type DiffRow = { path: string; before: unknown; after: unknown }

const ACTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  insert: 'success',
  update: 'secondary',
  delete: 'destructive',
  post: 'success',
  void: 'warning',
  approve: 'success',
  reject: 'destructive',
}

const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])
const CONTEXT_KEYS = new Set(['source', 'mode', 'reason'])
const ACRONYMS = new Set(['api', 'fx', 'gl', 'id', 'url'])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .split(' ')
    .map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function formatPath(path: string): string {
  return path.split('.').map(humanize).join(' › ')
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function collectDiffs(before: unknown, after: unknown, path = ''): DiffRow[] {
  if (sameValue(before, after)) return []
  if (Array.isArray(before) || Array.isArray(after)) return [{ path, before, after }]
  if (isObject(before) || isObject(after)) {
    const left = isObject(before) ? before : {}
    const right = isObject(after) ? after : {}
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    return keys.flatMap((key) => collectDiffs(left[key], right[key], path ? `${path}.${key}` : key))
  }
  return [{ path, before, after }]
}

function itemTitle(value: unknown, index: number, fallback: string, lineLabel: (line: string) => string): string {
  if (!isObject(value)) return `${fallback} ${index + 1}`
  if (typeof value.description === 'string' && value.description.length > 0) return value.description
  if (typeof value.line_number === 'string' || typeof value.line_number === 'number') return lineLabel(String(value.line_number))
  const identifyingValue = value.name ?? value.document_number ?? value.entry_number ?? value.id
  return typeof identifyingValue === 'string' && identifyingValue.length > 0
    ? identifyingValue
    : `${fallback} ${index + 1}`
}

function CompactValue({ value }: { value: unknown }) {
  const t = useTranslations('admin.audit.drawer')
  const format = useFormatter()
  if (value === null || value === undefined) return <span className="text-slate-400">{t('notSet')}</span>
  if (Array.isArray(value)) return <span className="text-slate-500 dark:text-slate-400">{t('itemCount', { count: value.length })}</span>
  if (isObject(value)) return <span className="text-slate-500 dark:text-slate-400">{t('propertyCount', { count: Object.keys(value).length })}</span>
  if (typeof value === 'boolean') return <Badge variant={value ? 'success' : 'outline'}>{value ? t('yes') : t('no')}</Badge>
  if (typeof value === 'number') return <span className="tabular-nums">{format.number(value, { maximumFractionDigits: 4 })}</span>
  const text = String(value)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
  return <span className={cn('break-words', isUuid && 'font-mono text-xs text-slate-600 dark:text-slate-300')}>{text}</span>
}

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const t = useTranslations('admin.audit.drawer')
  if (!Array.isArray(value) && !isObject(value)) return <CompactValue value={value} />

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">{t('emptyCollection')}</span>
    if (value.every((item) => !isObject(item) && !Array.isArray(item))) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item, index) => (
            <span key={index} className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
              <CompactValue value={item} />
            </span>
          ))}
        </div>
      )
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <details
            key={index}
            className="group overflow-hidden rounded-lg border border-slate-200 bg-white open:shadow-sm dark:border-slate-800 dark:bg-slate-950/30"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-700 marker:hidden hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60">
              <span className="truncate">{itemTitle(item, index, t('item'), (line) => t('lineItem', { line }))}</span>
              <span className="shrink-0 text-xs font-normal text-slate-400">{t('itemPosition', { current: index + 1, total: value.length })}</span>
            </summary>
            <div className="border-t border-slate-200 p-3 dark:border-slate-800">
              <JsonValue value={item} depth={depth + 1} />
            </div>
          </details>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value)
  if (entries.length === 0) return <span className="text-slate-400">{t('emptyCollection')}</span>
  return (
    <dl className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
      {entries.map(([key, entry], index) => (
        <div
          key={key}
          className={cn(
            'grid gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(9rem,0.32fr)_minmax(0,1fr)] sm:gap-4',
            index > 0 && 'border-t border-slate-100 dark:border-slate-800',
          )}
        >
          <dt className="text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400">{humanize(key)}</dt>
          <dd className="min-w-0 text-sm text-slate-800 dark:text-slate-200">
            <JsonValue value={entry} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function DiffList({ rows }: { rows: DiffRow[] }) {
  const t = useTranslations('admin.audit.drawer')
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {t('noDifferences')}
      </div>
    )
  }

  const grouped = new Map<string, DiffRow[]>()
  for (const row of rows) {
    const group = row.path.split('.')[0] || 'event'
    const groupRows = grouped.get(group)
    if (groupRows) groupRows.push(row)
    else grouped.set(group, [row])
  }
  return (
    <div className="space-y-3">
      {[...grouped.entries()].map(([group, groupRows]) => (
        <details key={group} open className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-slate-50 px-4 py-3 marker:hidden dark:bg-slate-800/50">
            <span className="font-medium text-slate-800 dark:text-slate-100">{humanize(group)}</span>
            <Badge variant="secondary">{t('changeCount', { count: groupRows.length })}</Badge>
          </summary>
          <div className="border-t border-slate-200 dark:border-slate-800">
            <div className="hidden grid-cols-[minmax(10rem,0.6fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 bg-slate-50/60 px-4 py-2 text-[11px] font-medium tracking-wide text-slate-500 uppercase sm:grid dark:bg-slate-950/20 dark:text-slate-400">
              <span>{t('field')}</span><span>{t('before')}</span><span>{t('after')}</span>
            </div>
            {groupRows.map((row, index) => (
              <div
                key={row.path}
                className={cn(
                  'grid gap-2 px-4 py-3 text-sm sm:grid-cols-[minmax(10rem,0.6fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4',
                  index > 0 && 'border-t border-slate-100 dark:border-slate-800',
                )}
              >
                <div className="font-medium text-slate-700 dark:text-slate-200">{formatPath(row.path)}</div>
                <div className="min-w-0 rounded-md bg-red-50/70 px-2.5 py-1.5 text-slate-700 dark:bg-red-950/20 dark:text-slate-300">
                  <span className="mb-1 block text-[10px] font-medium tracking-wide text-red-500 uppercase sm:hidden">{t('before')}</span>
                  <CompactValue value={row.before} />
                </div>
                <div className="min-w-0 rounded-md bg-emerald-50/70 px-2.5 py-1.5 text-slate-700 dark:bg-emerald-950/20 dark:text-slate-300">
                  <span className="mb-1 block text-[10px] font-medium tracking-wide text-emerald-600 uppercase sm:hidden">{t('after')}</span>
                  <CompactValue value={row.after} />
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

function MetadataCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">{icon}{label}</div>
      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{children}</div>
    </div>
  )
}

export function AuditEventDrawer({ event, closeHref }: { event: AuditEvent; closeHref: string }) {
  const t = useTranslations('admin.audit')
  const format = useFormatter()
  const changes = isObject(event.changes) ? event.changes : {}
  const hasBefore = Object.hasOwn(changes, 'before')
  const hasAfter = Object.hasOwn(changes, 'after')
  const tabs: DrawerTab[] = ['changes', ...(hasBefore ? ['before' as const] : []), ...(hasAfter ? ['after' as const] : [])]
  const [activeTab, setActiveTab] = useState<DrawerTab>('changes')
  const when = format.dateTime(new Date(event.at), { dateStyle: 'long', timeStyle: 'medium' })
  const actionLabel = KNOWN_ACTIONS.has(event.action) ? t(`actions.${event.action}` as never) : humanize(event.action)
  const actor = event.actorName ?? t('systemActor')
  const context = Object.fromEntries(Object.entries(changes).filter(([key]) => CONTEXT_KEYS.has(key)))

  const diffs = useMemo(() => {
    if (hasBefore || hasAfter) return collectDiffs(changes.before, changes.after)
    return Object.entries(changes)
      .filter(([key]) => !CONTEXT_KEYS.has(key))
      .flatMap(([key, value]) => Array.isArray(value) && value.length === 2
        ? [{ path: key, before: value[0], after: value[1] }]
        : [])
  }, [changes, hasAfter, hasBefore])

  const details = Object.fromEntries(Object.entries(changes).filter(([key, value]) => (
    !CONTEXT_KEYS.has(key)
    && key !== 'before'
    && key !== 'after'
    && !(Array.isArray(value) && value.length === 2)
  )))

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          <span>{humanize(event.recordType)}</span>
          <Badge variant={ACTION_VARIANT[event.action] ?? 'secondary'}>{actionLabel}</Badge>
        </span>
      }
      description={t('drawer.description', { actor, when })}
      subtabs={
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t('drawer.tabsAria')}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                activeTab === tab
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
              )}
            >
              {t(`drawer.tabs.${tab}`)}
            </button>
          ))}
        </nav>
      }
    >
      <div className="space-y-6 pb-2">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetadataCard icon={<Clock3 size={14} aria-hidden />} label={t('drawer.when')}>{when}</MetadataCard>
          <MetadataCard icon={<UserRound size={14} aria-hidden />} label={t('drawer.actor')}>{actor}</MetadataCard>
          <MetadataCard icon={<Database size={14} aria-hidden />} label={t('drawer.recordType')}>{humanize(event.recordType)}</MetadataCard>
          <MetadataCard icon={<Fingerprint size={14} aria-hidden />} label={t('drawer.reference')}>
            <span className="font-mono text-xs">{event.rowId}</span>
          </MetadataCard>
        </div>

        {activeTab === 'changes' ? (
          <>
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <History size={17} className="text-teal-600 dark:text-teal-400" aria-hidden />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.changedFields')}</h3>
              </div>
              <DiffList rows={diffs} />
            </section>

            {Object.keys(context).length > 0 || Object.keys(details).length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Braces size={17} className="text-teal-600 dark:text-teal-400" aria-hidden />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.eventContext')}</h3>
                </div>
                <JsonValue value={{ ...context, ...details }} />
              </section>
            ) : null}

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.technicalDetails')}</h3>
              <JsonValue value={{ eventId: event.id, requestId: event.requestId }} />
            </section>
          </>
        ) : null}

        {activeTab === 'before' ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.beforeSnapshot')}</h3>
            <JsonValue value={changes.before} />
          </section>
        ) : null}

        {activeTab === 'after' ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.afterSnapshot')}</h3>
            {changes.after === null ? (
              <div className="rounded-xl border border-dashed border-red-300 bg-red-50/50 px-4 py-10 text-center dark:border-red-900 dark:bg-red-950/20">
                <p className="font-medium text-red-800 dark:text-red-200">{t('drawer.recordRemoved')}</p>
                <p className="mt-1 text-sm text-red-600 dark:text-red-300">{t('drawer.recordRemovedDescription')}</p>
              </div>
            ) : <JsonValue value={changes.after} />}
          </section>
        ) : null}
      </div>
    </UrlDrawer>
  )
}

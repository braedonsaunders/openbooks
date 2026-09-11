'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Textarea, UrlDrawer } from '@openbooks/ui'
import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import {
  moveBlock,
  outlineSpec,
  removeBlock,
  type BlockPath,
  type OutlineNode,
} from '@/lib/page-layout-outline'
import type { FieldDescriptor } from '@/lib/page-fields'
import type { PageLayoutDrawerData } from './view'

/**
 * The editor for one route's layout.
 *
 * Two modes, deliberately unequal. **Structure** offers the two operations
 * that are always safe — hide a block, move it among its siblings — because
 * they only remove and reorder blocks that were already in the document.
 * They cannot invent a widget or bind a field that does not exist, so they
 * need no validation and cannot produce a page that fails to render.
 * **JSON** can do all three, so everything it produces is validated by the
 * server before it is stored, and the errors name the offending widget or
 * path rather than saying "invalid".
 *
 * The thing this screen must not let anyone discover by accident is that a
 * saved layout REPLACES the built-in page rather than patching it: the page
 * stops tracking the app's own improvements until the customization is
 * removed. That is a property of how layouts are stored, not something this
 * editor could paper over, so it is stated on the way in.
 */

const TONE = {
  chrome: 'text-slate-500 dark:text-slate-400',
  mono: 'font-mono text-[11px]',
}

function Node({
  node,
  depth,
  onMove,
  onRemove,
  t,
}: {
  node: OutlineNode
  depth: number
  onMove: (path: BlockPath, delta: -1 | 1) => void
  onRemove: (path: BlockPath) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <li>
      {/* The path is the row's identity. Children nest inside this `li`, so
          the row element — not the list item — is what addresses one block. */}
      <div
        data-block-path={node.path.join('.')}
        className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {t.has(`blocks.${node.kind}` as never) ? t(`blocks.${node.kind}` as never) : node.kind}
        </span>
        {node.name ? (
          <span className={node.nameIsBinding ? `${TONE.mono} text-indigo-600 dark:text-indigo-400` : 'text-sm text-slate-500'}>
            {node.nameIsBinding ? `{ ${node.name} }` : node.name}
          </span>
        ) : null}
        {node.count !== null ? (
          <span className={`text-xs ${TONE.chrome}`}>{t('outline.count', { count: node.count })}</span>
        ) : null}
        {node.conditional ? (
          // Worth saying: the page may already be omitting this block for some
          // readers, and hiding something that was never showing is confusing.
          <Badge variant="outline" className="text-[10px]">{t('outline.conditional')}</Badge>
        ) : null}
        {/* Dimmed, never hidden. Controls that appear only on hover are
            unreachable by touch and invisible to anyone scanning the row, and
            these three are the entire point of the screen. */}
        <span className="ml-auto flex items-center gap-1 opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
          <Button size="icon" variant="ghost" aria-label={t('outline.moveUp')} onClick={() => onMove(node.path, -1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" aria-label={t('outline.moveDown')} onClick={() => onMove(node.path, 1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" aria-label={t('outline.hide')} onClick={() => onRemove(node.path)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <Node key={child.path.join('.')} node={child} depth={depth + 1} onMove={onMove} onRemove={onRemove} t={t} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function Fields({ fields, truncated, t }: { fields: FieldDescriptor[]; truncated: boolean; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="space-y-1">
      <p className={`text-xs ${TONE.chrome}`}>{t('fields.help')}</p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {fields.map((f) => (
          <li key={f.path} className="py-1.5">
            <div className="flex items-baseline gap-2">
              <code className={`${TONE.mono} text-indigo-600 dark:text-indigo-400`}>{f.path}</code>
              <span className={`text-[11px] ${TONE.chrome}`}>{f.type}</span>
              {f.count !== undefined ? (
                // Rows, not "parts": an array here is DATA the page loaded,
                // not a piece of the layout, and borrowing the block word for
                // both would make the two lists read as the same thing.
                <span className={`text-[11px] ${TONE.chrome}`}>{t('fields.count', { count: f.count })}</span>
              ) : null}
              {f.sample !== undefined ? (
                <span className="truncate text-xs text-slate-600 dark:text-slate-300">{f.sample}</span>
              ) : null}
            </div>
            {f.item && f.item.length > 0 ? (
              <ul className="mt-1 pl-4">
                {f.item.map((row) => (
                  <li key={row.path} className="flex items-baseline gap-2">
                    {/* Row paths resolve against an ITEM, which is what a
                        table's columns and a repeat's blocks see. */}
                    <code className={`${TONE.mono} text-slate-500`}>{row.path}</code>
                    <span className={`text-[11px] ${TONE.chrome}`}>{row.type}</span>
                    {row.sample !== undefined ? (
                      <span className="truncate text-xs text-slate-500">{row.sample}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {truncated ? <p className={`text-xs ${TONE.chrome}`}>{t('fields.truncated')}</p> : null}
    </div>
  )
}

export function LayoutDrawer({ drawer }: { drawer: PageLayoutDrawerData }) {
  const t = useTranslations('admin.pageLayouts')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const initial = drawer.override ?? drawer.builtIn
  const [working, setWorking] = useState<PageSpec | null>(initial)
  const [undo, setUndo] = useState<PageSpec[]>([])
  const [mode, setMode] = useState<'structure' | 'json' | 'preview' | 'fields'>('structure')
  const [json, setJson] = useState(() => (initial ? JSON.stringify(initial, null, 2) : ''))
  // Blank each time: a note explains THIS change, so carrying the previous
  // one forward would quietly attribute an old reason to a new edit.
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  /** The url of the live preview, and a token that forces the frame to reload. */
  const [preview, setPreview] = useState<{ href: string; nonce: number } | null>(null)

  const outline = useMemo(() => (working ? outlineSpec(working) : null), [working])
  const dirty = working !== initial

  /** Apply a structural edit, keeping an undo entry only when it changed. */
  const apply = (next: PageSpec) => {
    if (!working || next === working) return
    setUndo((stack) => [...stack, working])
    setWorking(next)
    setJson(JSON.stringify(next, null, 2))
    setErrors([])
  }

  const revert = () => {
    const previous = undo[undo.length - 1]
    if (!previous) return
    setUndo((stack) => stack.slice(0, -1))
    setWorking(previous)
    setJson(JSON.stringify(previous, null, 2))
    setErrors([])
  }

  /** The document to send: the JSON tab's text when it is the active edit. */
  const candidate = (): PageSpec | null => {
    if (mode !== 'json') return working
    try {
      return JSON.parse(json) as PageSpec
    } catch (error) {
      setErrors([t('errors.json', { message: (error as Error).message })])
      return null
    }
  }

  const post = async (spec: PageSpec, validateOnly: boolean) => {
    const response = await fetch(`/api/page-specs${validateOnly ? '?validate=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: drawer.route, spec, note: note.trim() || null }),
    })
    const body = (await response.json().catch(() => ({}))) as { errors?: string[]; error?: string }
    if (!response.ok) {
      // Returned to the author, never swallowed: an unknown widget has to be
      // NAMED or there is nothing to act on.
      setErrors(body.errors ?? [body.error ?? tCommon('errors.unknown')])
      return false
    }
    setErrors([])
    return true
  }

  /**
   * Store the working layout as this author's draft and point the frame at
   * the REAL route with `?layoutPreview=1`.
   *
   * Not a rendering of its own: the frame loads the page every reader loads,
   * which is the only way a preview can be trusted to match what shipping the
   * layout would actually do.
   */
  const showPreview = async () => {
    const spec = candidate()
    if (!spec) return
    setBusy(true)
    try {
      const response = await fetch('/api/page-specs?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: drawer.route, spec, params: drawer.segments }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        previewUrl?: string
        errors?: string[]
        error?: string
      }
      if (!response.ok || !body.previewUrl) {
        setErrors(body.errors ?? [body.error ?? tCommon('errors.unknown')])
        return
      }
      setErrors([])
      setPreview({ href: body.previewUrl, nonce: Date.now() })
      // Opened only after the draft is stored, so the new tab never races the
      // write and shows the layout the author had a moment ago.
      window.open(body.previewUrl, '_blank', 'noopener,noreferrer')
    } finally {
      setBusy(false)
    }
  }

  const validate = async () => {
    const spec = candidate()
    if (!spec) return
    setBusy(true)
    try {
      if (await post(spec, true)) toast.success(t('actions.validated'))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const spec = candidate()
    if (!spec) return
    setBusy(true)
    try {
      if (await post(spec, false)) {
        toast.success(t('actions.saved'))
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const response = await fetch(`/api/page-specs?route=${encodeURIComponent(drawer.route)}`, { method: 'DELETE' })
      if (!response.ok) {
        setErrors([tCommon('errors.unknown')])
        return
      }
      toast.success(t('actions.removed'))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const TABS = ['structure', 'json', 'preview', 'fields'] as const

  // The drawer chrome owns the tab strip, so the tabs sit above the scrolling
  // body instead of scrolling away with it.
  const subtabs = working ? (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t('tabs.aria')}>
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={mode === tab}
          onClick={() => setMode(tab)}
          className={
            mode === tab
              ? 'shrink-0 border-b-2 border-teal-600 px-3 py-3 text-sm font-medium text-teal-700 transition-colors dark:border-teal-400 dark:text-teal-300'
              : 'shrink-0 border-b-2 border-transparent px-3 py-3 text-sm font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200'
          }
        >
          {t(`tabs.${tab}`)}
        </button>
      ))}
    </nav>
  ) : undefined

  return (
    <UrlDrawer
      open
      closeHref="/admin/page-layouts"
      size="xl"
      title={drawer.route}
      description={drawer.override ? t('drawer.customized') : t('drawer.builtIn')}
      subtabs={subtabs}
      headerActions={
        <>
          {undo.length > 0 ? (
            <Button variant="ghost" disabled={busy} onClick={revert}>
              <Undo2 className="mr-1 h-3.5 w-3.5" />
              {t('actions.undo')}
            </Button>
          ) : null}
          <Button disabled={busy || !working || (mode !== 'json' && !dirty)} onClick={save}>
            {busy ? tCommon('actions.saving') : t('actions.save')}
          </Button>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {drawer.override ? (
            <Button variant="destructive" disabled={busy} onClick={remove}>
              {t('actions.remove')}
            </Button>
          ) : (
            <span />
          )}
          {mode === 'json' ? (
            <Button variant="outline" disabled={busy} onClick={validate}>
              {t('actions.validate')}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Stated on the way in, not discovered later: a stored layout is the
            whole page, so the route stops tracking the app's own changes. */}
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('drawer.replacesWarning')}
        </p>

        {drawer.unavailable ? (
          <p className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            {drawer.unavailable}
          </p>
        ) : null}

        {errors.length > 0 ? (
          <ul className="space-y-0.5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {errors.slice(0, 10).map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        ) : null}

        {working ? (
          <>
            {mode === 'structure' && outline ? (
              <div className="space-y-3">
                {(['header', 'body'] as const).map((region) => (
                  <section key={region}>
                    <h3 className={`px-2 text-xs font-semibold uppercase tracking-wide ${TONE.chrome}`}>
                      {t(`outline.${region}`)}
                    </h3>
                    <ul>
                      {outline[region].map((node) => (
                        <Node
                          key={node.path.join('.')}
                          node={node}
                          depth={0}
                          onMove={(path, delta) => apply(moveBlock(working, path, delta))}
                          onRemove={(path) => apply(removeBlock(working, path))}
                          t={t}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : null}

            {mode === 'json' ? (
              <Textarea
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
                className="h-[28rem] font-mono text-xs"
                aria-label={t('tabs.json')}
              />
            ) : null}

            {mode === 'preview' ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('preview.help')}</p>
                {/* A new tab rather than an inline frame, and not for want of
                    trying: the app sends `X-Frame-Options: DENY` and
                    `frame-ancestors 'none'`, which is the clickjacking
                    protection every page depends on. Relaxing it for requests
                    carrying `?layoutPreview=1` would make that protection
                    opt-out via a query parameter an attacker can add. The
                    convenience is not worth the hole — do not "fix" this by
                    widening the header. */}
                <p className={`text-xs ${TONE.chrome}`}>{t('preview.newTab')}</p>
                <Button disabled={busy} onClick={showPreview}>
                  {busy ? tCommon('actions.saving') : t('actions.openPreview')}
                </Button>
                {preview ? (
                  <p className={`text-xs ${TONE.chrome}`}>
                    {t('preview.opened')} <code className={TONE.mono}>{preview.href}</code>
                  </p>
                ) : null}
              </div>
            ) : null}

            {mode === 'fields' ? (
              <Fields fields={drawer.fields} truncated={drawer.fieldsTruncated} t={t} />
            ) : null}

            <div className="space-y-1">
              <label className={`text-xs ${TONE.chrome}`} htmlFor="page-layout-note">
                {t('drawer.note')}
              </label>
              <Input
                id="page-layout-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('drawer.notePlaceholder')}
                maxLength={500}
              />
            </div>
          </>
        ) : null}
      </div>
    </UrlDrawer>
  )
}

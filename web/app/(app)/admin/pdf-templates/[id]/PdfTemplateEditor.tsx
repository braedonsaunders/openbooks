'use client'

// The PDF template editor shell — top bar (name, paper setup, save), a
// header/footer bar, and three bodies: Design (GrapesJS paper canvas), HTML
// (CodeMirror source), Preview (exact Chromium-rendered PDF merged with the
// org's most recent record). The design and code tabs edit the SAME source —
// switching serializes one into the other, so raw-HTML authors and visual
// authors round-trip losslessly.

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { Editor } from 'grapesjs'
import { html as htmlLang } from '@codemirror/lang-html'
import { EditorView } from '@codemirror/view'
import { ArrowLeft } from 'lucide-react'
import { Badge, Button, Input } from '@openbooks/ui'
import { confirmDialog } from '../../../../../lib/confirm'
import { prettifyTemplateHtml } from '../../../../../lib/pdf-templates/prettify'
import { serializeTemplateEditor, type PaletteCollection, type PaletteField } from './builder-blocks'

const PdfBuilder = dynamic(() => import('./PdfBuilder'), { ssr: false })
const CodeMirror = dynamic(() => import('@uiw/react-codemirror'), { ssr: false })

export type EditorTemplate = {
  id: string
  recordType: string
  recordTypeLabel: string
  name: string
  description: string | null
  paperSize: 'letter' | 'a4' | 'legal'
  orientation: 'portrait' | 'landscape'
  marginMm: number
  headerHtml: string | null
  footerHtml: string | null
  sourceHtml: string
  isDefault: boolean
  isActive: boolean
}

// 96-dpi page pixel sizes (portrait) per paper.
const PAPER_PX: Record<string, [number, number]> = {
  letter: [816, 1056],
  a4: [794, 1123],
  legal: [816, 1344],
}
const PAPER_LABEL: Record<string, string> = { letter: 'Letter', a4: 'A4', legal: 'Legal' }
const MM_TO_PX = 3.7795

export default function PdfTemplateEditor({
  template,
  mergeFields,
  collections,
}: {
  template: EditorTemplate
  mergeFields: PaletteField[]
  collections: PaletteCollection[]
}) {
  const t = useTranslations('pdfTemplates')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [tab, setTab] = useState<'design' | 'code' | 'preview'>('design')
  const [name, setName] = useState(template.name)
  const [paperSize, setPaperSize] = useState(template.paperSize)
  const [orientation, setOrientation] = useState(template.orientation)
  const [marginMm, setMarginMm] = useState(template.marginMm)
  const [headerHtml, setHeaderHtml] = useState(template.headerHtml ?? '')
  const [footerHtml, setFooterHtml] = useState(template.footerHtml ?? '')
  const [isDefault, setIsDefault] = useState(template.isDefault)
  const [sourceHtml, setSourceHtml] = useState(template.sourceHtml)
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  // Remount the builder whenever we re-enter Design so it reloads sourceHtml.
  const [designEpoch, setDesignEpoch] = useState(0)
  const editorRef = useRef<Editor | null>(null)

  const [pw, ph] = PAPER_PX[paperSize] ?? PAPER_PX.letter!
  const pageWidthPx = orientation === 'landscape' ? ph : pw
  const pageHeightPx = orientation === 'landscape' ? pw : ph
  const marginPx = Math.round(marginMm * MM_TO_PX)

  /** The current source, preferring the live canvas when Design is open. */
  const snapshot = useCallback((): string => {
    if (tab === 'design' && editorRef.current) {
      try {
        return serializeTemplateEditor(editorRef.current)
      } catch {
        return sourceHtml
      }
    }
    return sourceHtml
  }, [tab, sourceHtml])

  function switchTab(next: 'design' | 'code' | 'preview') {
    if (next === tab) return
    const current = snapshot()
    setSourceHtml(current)
    if (next === 'design') {
      editorRef.current = null
      setDesignEpoch((n) => n + 1)
    }
    if (next === 'code') {
      // Show human-readable markup even before the first save (the canvas
      // serializes to one long line). Whitespace-only; render-neutral.
      void prettifyTemplateHtml(current).then((pretty) => setSourceHtml(pretty))
    }
    if (next === 'preview') void refreshPreview(current)
    setTab(next)
  }

  async function refreshPreview(source?: string) {
    setPreviewBusy(true)
    try {
      const res = await fetch('/api/pdf-templates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordType: template.recordType,
          sourceHtml: source ?? snapshot(),
          headerHtml,
          footerHtml,
          paperSize,
          orientation,
          marginMm,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error ?? t('editor.previewFailed'))
        return
      }
      const blob = await res.blob()
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(blob)
      })
    } finally {
      setPreviewBusy(false)
    }
  }

  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl])

  async function save() {
    const source = snapshot()
    setSourceHtml(source)
    setBusy(true)
    try {
      const res = await fetch(`/api/pdf-templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sourceHtml: source,
          headerHtml,
          footerHtml,
          paperSize,
          orientation,
          marginMm,
          isDefault,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? t('editor.saveFailed'))
        return
      }
      toast.success(t('editor.saved'))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!(await confirmDialog({ title: tCommon('actions.delete'), message: t('editor.deleteConfirm'), tone: 'danger' }))) return
    setBusy(true)
    const res = await fetch(`/api/pdf-templates/${template.id}`, { method: 'DELETE' })
    if (res.ok) {
      router.push(`/admin/pdf-templates?recordType=${template.recordType}`)
    } else {
      setBusy(false)
      toast.error(t('editor.saveFailed'))
    }
  }

  const tabButton = (key: 'design' | 'code' | 'preview', label: string) => (
    <button
      onClick={() => switchTab(key)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        tab === key
          ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-[calc(100vh-6.5rem)] min-h-[540px] flex-col gap-3">
      {/* ---- Top bar ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/pdf-templates?recordType=${template.recordType}`}
          className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft size={15} /> {t('editor.back')}
        </Link>
        <Badge variant="secondary">{template.recordTypeLabel}</Badge>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-64" />
        <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
          {tabButton('design', t('editor.design'))}
          {tabButton('code', t('editor.code'))}
          {tabButton('preview', t('editor.preview'))}
        </div>
        <span className="flex-1" />
        <select
          value={paperSize}
          onChange={(e) => setPaperSize(e.target.value as EditorTemplate['paperSize'])}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          {Object.entries(PAPER_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as EditorTemplate['orientation'])}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="portrait">{t('editor.portrait')}</option>
          <option value="landscape">{t('editor.landscape')}</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          {t('editor.margins')}
          <Input
            type="number"
            min={0}
            max={50}
            value={marginMm}
            onChange={(e) => setMarginMm(Math.min(50, Math.max(0, Number(e.target.value) || 0)))}
            className="h-9 w-16"
          />
          mm
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          {t('editor.makeDefault')}
        </label>
        <Button onClick={save} disabled={busy}>
          {busy ? tCommon('actions.saving') : tCommon('actions.save')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={remove}
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          {tCommon('actions.delete')}
        </Button>
      </div>

      {/* ---- Running header/footer ---- */}
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={headerHtml}
          onChange={(e) => setHeaderHtml(e.target.value)}
          placeholder={t('editor.headerPlaceholder')}
          className="h-8 font-mono text-xs"
        />
        <Input
          value={footerHtml}
          onChange={(e) => setFooterHtml(e.target.value)}
          placeholder={t('editor.footerPlaceholder')}
          className="h-8 font-mono text-xs"
        />
      </div>

      {/* ---- Body ---- */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        {tab === 'design' ? (
          <PdfBuilder
            key={designEpoch}
            initialHtml={sourceHtml}
            pageWidthPx={pageWidthPx}
            pageHeightPx={pageHeightPx}
            marginPx={marginPx}
            paperLabel={`${PAPER_LABEL[paperSize]} · ${orientation === 'landscape' ? t('editor.landscape') : t('editor.portrait')}`}
            onReady={(ed) => {
              editorRef.current = ed
            }}
            mergeFields={mergeFields}
            collections={collections}
            labels={{
              content: t('editor.blockContent'),
              fields: t('editor.blockFields'),
              tables: t('editor.blockTables'),
            }}
          />
        ) : tab === 'code' ? (
          <div className="h-full overflow-auto bg-white dark:bg-slate-950">
            <CodeMirror
              value={sourceHtml}
              onChange={(v) => setSourceHtml(v)}
              extensions={[htmlLang(), EditorView.lineWrapping]}
              height="100%"
              style={{ height: '100%', fontSize: 12 }}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col bg-[#3f4856]">
            <div className="flex items-center gap-3 border-b border-black/20 px-3 py-2">
              <span className="text-xs text-white/80">{t('editor.previewHint')}</span>
              <span className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => refreshPreview()} disabled={previewBusy}>
                {previewBusy ? tCommon('actions.saving') : t('editor.refreshPreview')}
              </Button>
            </div>
            {previewUrl ? (
              <iframe title="pdf-preview" src={previewUrl} className="min-h-0 w-full flex-1" />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-white/70">
                {previewBusy ? '…' : t('editor.previewHint')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

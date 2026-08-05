'use client'

// GrapesJS visual builder for PDF documents — the canvas is styled as a real
// PAPER SHEET: the body is sized to the exact page (width × height at 96 dpi),
// the page margin is rendered as the sheet's internal whitespace with a dashed
// boundary guide, and it floats on a dark "desk" surround. The styling
// re-applies live when paper size / orientation / margin change in the top bar.
// Multi-page pagination is the Preview tab (exact Chromium render); here it's
// one tall sheet.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import GjsEditor, { BlocksProvider, Canvas } from '@grapesjs/react'
import grapesjs, { type Editor } from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import { BlockPalette } from './BlockPalette'
import {
  collectionTableBlockHtml,
  mergeFieldBlockHtml,
  type PaletteCollection,
  type PaletteField,
} from './builder-blocks'

const STARTER_HTML =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;">' +
  '<h1 style="font-size:22px;margin:0 0 8px;">Document title</h1>' +
  '<p style="font-size:13px;line-height:1.6;color:#334155;margin:0;">Drag content + record fields from the left.</p>' +
  '</div>'

const LIGHT_THEME: CSSProperties & Record<string, string> = {
  '--gjs-primary-color': '#f1f5f9',
  '--gjs-secondary-color': '#334155',
  '--gjs-tertiary-color': '#0d9488',
  '--gjs-quaternary-color': '#0f766e',
  '--gjs-font-color': '#334155',
  '--gjs-font-color-active': '#0f172a',
  '--gjs-main-dark-color': '#e2e8f0',
}

const BASE_BLOCKS: { id: string; label: string; content: string }[] = [
  {
    id: 'heading',
    label: 'Heading',
    content:
      '<h2 style="font-size:16px;font-weight:700;color:#0f172a;margin:16px 0 6px;border-bottom:2px solid #e2e8f0;padding-bottom:4px;">Section heading</h2>',
  },
  {
    id: 'text',
    label: 'Text',
    content:
      '<p style="font-size:13px;line-height:1.6;color:#334155;margin:0 0 8px;">Your text here.</p>',
  },
  {
    id: 'image',
    label: 'Image',
    content:
      '<img src="https://placehold.co/600x180" alt="" style="max-width:100%;display:block;margin:6px 0;" />',
  },
  {
    id: 'divider',
    label: 'Divider',
    content: '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;" />',
  },
  {
    id: 'pagebreak',
    label: 'Page break',
    content:
      '<div style="break-after:page;page-break-after:always;height:0;font-size:0;">&nbsp;</div>',
  },
  {
    id: 'spacer',
    label: 'Spacer',
    content: '<div style="height:16px;line-height:16px;">&nbsp;</div>',
  },
  {
    id: 'two-col',
    label: '2 columns',
    content:
      '<table style="width:100%;border-collapse:collapse;margin:6px 0;"><tr>' +
      '<td style="width:50%;vertical-align:top;padding-right:8px;font-size:13px;color:#334155;">Column one</td>' +
      '<td style="width:50%;vertical-align:top;padding-left:8px;font-size:13px;color:#334155;">Column two</td>' +
      '</tr></table>',
  },
  {
    id: 'detail-row',
    label: 'Label + value',
    content:
      '<table style="border-collapse:collapse;margin:0 0 2px;"><tr>' +
      '<td style="padding:4px 12px 4px 0;font-size:12px;color:#64748b;white-space:nowrap;">Label</td>' +
      '<td style="padding:4px 0;font-size:13px;color:#0f172a;">{{token}}</td>' +
      '</tr></table>',
  },
]

// Build the canvas stylesheet that turns the GrapesJS iframe body into a paper
// sheet at the exact page size, with the margin shown as inner whitespace + a
// dashed boundary guide, floating on a dark desk.
function pageCss(pageWidthPx: number, pageHeightPx: number, marginPx: number): string {
  return (
    `html{background:#3f4856;padding:0;margin:0;}` +
    // The sheet shows at true page width when the pane is wide enough, else
    // shrinks to fit (min) — so it NEVER overflows the canvas and always
    // centers. !important on margin: GrapesJS injects its own `body{margin:0}`
    // later in the cascade, which otherwise pins the sheet left.
    `body{box-sizing:border-box;width:min(${pageWidthPx}px, 100% - 48px);` +
    `min-height:${pageHeightPx}px;` +
    `margin:24px auto !important;background:#fff;padding:${marginPx}px;position:relative;` +
    `box-shadow:0 10px 34px rgba(0,0,0,.4);border-radius:1px;` +
    `font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;}` +
    // dashed margin/content boundary guide (non-interactive)
    `body::before{content:'';position:absolute;inset:${marginPx}px;` +
    `border:1px dashed #cbd5e1;pointer-events:none;z-index:0;}` +
    // keep authored content above the guide
    `body>*{position:relative;z-index:1;}`
  )
}

export default function PdfBuilder({
  initialHtml,
  pageWidthPx,
  pageHeightPx,
  marginPx,
  paperLabel,
  onReady,
  mergeFields = [],
  collections = [],
  labels,
}: {
  initialHtml?: string | null
  pageWidthPx: number
  pageHeightPx: number
  marginPx: number
  paperLabel?: string
  onReady: (editor: Editor) => void
  mergeFields?: PaletteField[]
  collections?: PaletteCollection[]
  labels: { content: string; fields: string; tables: string }
}) {
  const editorRef = useRef<Editor | null>(null)
  const [, setEditor] = useState<Editor | null>(null)

  // Re-apply the paper-sheet CSS whenever the page dimensions change (the user
  // picks A4 / landscape / a new margin in the top bar). The load handler
  // injects a <style id="ob-page-css"> we update in place here.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const doc = ed.Canvas.getBody()?.ownerDocument
    const el = doc?.getElementById('ob-page-css')
    if (el) el.innerHTML = pageCss(pageWidthPx, pageHeightPx, marginPx)
  }, [pageWidthPx, pageHeightPx, marginPx])

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-900"
      style={LIGHT_THEME}
    >
      <GjsEditor
        grapesjs={grapesjs}
        options={{ height: '100%', storageManager: false, fromElement: false }}
        onEditor={(editor: Editor) => {
          const bm = editor.BlockManager
          for (const b of BASE_BLOCKS) {
            bm.add(b.id, { label: b.label, category: labels.content, content: b.content })
          }
          for (const f of mergeFields) {
            const content = mergeFieldBlockHtml(f)
            if (!content) continue
            bm.add(`token:${f.key}`, {
              label: f.label || f.key,
              category: labels.fields,
              content,
            })
          }
          for (const c of collections) {
            const content = collectionTableBlockHtml(c)
            if (!content) continue
            bm.add(`table:${c.key}`, {
              label: `${c.label}`,
              category: labels.tables,
              content,
            })
          }
          // Style the canvas as a real paper sheet once the iframe is ready.
          editor.on('load', () => {
            const doc = editor.Canvas.getBody()?.ownerDocument
            if (!doc) return
            const style = doc.createElement('style')
            style.id = 'ob-page-css'
            style.innerHTML = pageCss(pageWidthPx, pageHeightPx, marginPx)
            doc.head.appendChild(style)
          })
          try {
            editor.setComponents(initialHtml?.trim() ? initialHtml : STARTER_HTML)
          } catch {
            try {
              editor.setComponents(STARTER_HTML)
            } catch {
              /* noop */
            }
          }
          editorRef.current = editor
          setEditor(editor)
          onReady(editor)
        }}
      >
        <div className="grid h-full min-h-0 grid-cols-4 grid-rows-1">
          <aside className="col-span-1 min-h-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
            <BlocksProvider>{(props) => <BlockPalette {...props} />}</BlocksProvider>
          </aside>
          <div className="relative col-span-3 min-h-0 overflow-hidden bg-[#3f4856]">
            {paperLabel ? (
              <span className="pointer-events-none absolute top-2 right-3 z-10 rounded-full bg-black/35 px-2.5 py-1 text-[11px] font-medium tracking-wide text-white/90 uppercase backdrop-blur-sm">
                {paperLabel}
              </span>
            ) : null}
            <Canvas className="h-full" />
          </div>
        </div>
      </GjsEditor>
    </div>
  )
}

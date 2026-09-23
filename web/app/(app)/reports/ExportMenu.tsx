'use client'

import { useState } from 'react'
import { ChevronDown, Download, FileText, Printer, Sheet } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Popover } from '@openbooks/ui'
import { downloadExportFile } from '../../../lib/export-download'

/**
 * One compact "Export" button that opens a menu with Print / PDF / Excel / CSV,
 * so the report toolbar stays a single tidy row instead of four buttons. Print
 * fetches the PDF and opens the native print dialog on it (paper output).
 *
 * File exports (UX-16b) are never bare download links: each format is fetched
 * first, and ONLY after the bytes arrive is the download triggered (with the
 * server's filename) and completion announced in a toast plus an accessible
 * live-region status naming the file. A server refusal surfaces its named
 * error instead of downloading an error body.
 */
export function ExportMenu({ kind, params, baseHref }: {
  kind?: string
  params?: Record<string, string | undefined>
  /** Override endpoint (e.g. a saved definition's export route); `format` is appended. */
  baseHref?: string
}) {
  const t = useTranslations('reports.export')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Last completed download, tied to the actual file: the filename read back
  // from the response disposition. Rendered in a live region AND a toast so
  // completion is announced instead of silent.
  const [done, setDone] = useState<string | null>(null)

  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v)
  const url = (format: string) => baseHref
    ? `${baseHref}${baseHref.includes('?') ? '&' : '?'}format=${format}`
    : `/api/reports/statement/${kind}/export?${new URLSearchParams({ format, ...Object.fromEntries(qs) })}`
  const pdf = url('pdf')

  async function print() {
    setOpen(false)
    try {
      const res = await fetch(pdf)
      if (!res.ok) throw new Error('print')
      const objUrl = URL.createObjectURL(await res.blob())
      const iframe = document.createElement('iframe')
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
      iframe.src = objUrl
      iframe.onload = () => {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        setTimeout(() => {
          URL.revokeObjectURL(objUrl)
          iframe.remove()
        }, 60_000)
      }
      document.body.appendChild(iframe)
    } catch {
      toast.error(t('printFailed'))
    }
  }

  async function download(format: 'pdf' | 'xlsx' | 'csv') {
    if (busy) return
    const formatLabel = t(format)
    // The menu stays open with a busy item while fetching; success is never
    // announced optimistically on click.
    setBusy(format)
    setDone(null)
    try {
      const filename = await downloadExportFile(url(format), undefined, {
        fallbackFilename: `${kind ?? 'report'}.${format}`,
        failedMessage: t('exportFailed', { format: formatLabel }),
      })
      setOpen(false)
      // Completion is claimed only now: the bytes arrived and the download
      // started, with the real filename.
      setDone(filename)
      toast.success(t('exported', { filename }))
    } catch (e) {
      setOpen(false)
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-800'

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        trigger={
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            <Download size={14} /> {t('export')} <ChevronDown size={13} className="opacity-60" />
          </Button>
        }
      >
        <div className="w-40 p-1">
          <button type="button" className={item} onClick={print} disabled={busy !== null}>
            <Printer size={14} /> {t('print')}
          </button>
          <button type="button" className={item} onClick={() => download('pdf')} disabled={busy !== null}>
            <FileText size={14} /> {busy === 'pdf' ? t('exporting', { format: t('pdf') }) : t('pdf')}
          </button>
          <button type="button" className={item} onClick={() => download('xlsx')} disabled={busy !== null}>
            <Sheet size={14} /> {busy === 'xlsx' ? t('exporting', { format: t('xlsx') }) : t('xlsx')}
          </button>
          <button type="button" className={item} onClick={() => download('csv')} disabled={busy !== null}>
            <Download size={14} /> {busy === 'csv' ? t('exporting', { format: t('csv') }) : t('csv')}
          </button>
        </div>
      </Popover>
      {done ? <span role="status" className="sr-only">{t('exported', { filename: done })}</span> : null}
    </>
  )
}

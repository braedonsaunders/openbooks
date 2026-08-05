'use client'

import { useState } from 'react'
import { ChevronDown, Download, FileText, Printer, Sheet } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Popover } from '@openbooks/ui'

/**
 * One compact "Export" button that opens a menu with Print / PDF / Excel / CSV,
 * so the report toolbar stays a single tidy row instead of four buttons. Print
 * fetches the PDF and opens the native print dialog on it (paper output).
 */
export function ExportMenu({ kind, params }: { kind: string; params: Record<string, string | undefined> }) {
  const t = useTranslations('reports.export')
  const [open, setOpen] = useState(false)

  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
  const url = (format: string) => `/api/reports/statement/${kind}/export?${new URLSearchParams({ format, ...Object.fromEntries(qs) })}`
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

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'

  return (
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
        <button type="button" className={item} onClick={print}>
          <Printer size={14} /> {t('print')}
        </button>
        <a className={item} href={pdf} onClick={() => setOpen(false)}>
          <FileText size={14} /> {t('pdf')}
        </a>
        <a className={item} href={url('xlsx')} onClick={() => setOpen(false)}>
          <Sheet size={14} /> {t('xlsx')}
        </a>
        <a className={item} href={url('csv')} onClick={() => setOpen(false)}>
          <Download size={14} /> {t('csv')}
        </a>
      </div>
    </Popover>
  )
}

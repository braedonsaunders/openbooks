'use client'

import { useState } from 'react'
import { ChevronDown, Download, FileText, Sheet } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Popover } from '@openbooks/ui'
import { downloadExportFile } from '../lib/export-download'
import {
  accountRegisterExportHref,
  type AccountRegisterExportFormat,
} from '../lib/account-register-export'

/**
 * Account register exports (UX-16b) are never bare download links: each format
 * is fetched first, and ONLY after the bytes arrive is the download triggered
 * (with the server's filename) and completion announced in a toast plus an
 * accessible live-region status naming the file. A server refusal surfaces its
 * named error instead of downloading an error body.
 */
export function AccountRegisterExportMenu({
  accountId,
  from,
  to,
  search,
  book,
}: {
  accountId: string
  from?: string | null
  to?: string | null
  search?: string | null
  book?: string | null
}) {
  const t = useTranslations('reports.export')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<AccountRegisterExportFormat | null>(null)
  // Last completed download, tied to the actual file: the filename read back
  // from the response disposition. Rendered in a live region AND a toast so
  // completion is announced instead of silent.
  const [done, setDone] = useState<string | null>(null)

  async function download(format: AccountRegisterExportFormat) {
    if (busy) return
    const formatLabel = t(format)
    // The menu stays open with a busy item while fetching; success is never
    // announced optimistically on click.
    setBusy(format)
    setDone(null)
    try {
      const filename = await downloadExportFile(
        accountRegisterExportHref(accountId, format, { from, to, search, book }),
        undefined,
        {
          fallbackFilename: `register.${format}`,
          failedMessage: t('exportFailed', { format: formatLabel }),
        },
      )
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

  const item =
    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-800'

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('export')}
            onClick={() => setOpen((current) => !current)}
          >
            <Download size={14} />
            <span className="hidden sm:inline">{t('export')}</span>
            <ChevronDown size={12} className="opacity-50" />
          </Button>
        }
      >
        <div className="w-40 p-1">
          <button
            type="button"
            className={item}
            onClick={() => download('pdf')}
            disabled={busy !== null}
          >
            <FileText size={14} /> {busy === 'pdf' ? t('exporting', { format: t('pdf') }) : t('pdf')}
          </button>
          <button
            type="button"
            className={item}
            onClick={() => download('xlsx')}
            disabled={busy !== null}
          >
            <Sheet size={14} /> {busy === 'xlsx' ? t('exporting', { format: t('xlsx') }) : t('xlsx')}
          </button>
          <button
            type="button"
            className={item}
            onClick={() => download('csv')}
            disabled={busy !== null}
          >
            <Download size={14} /> {busy === 'csv' ? t('exporting', { format: t('csv') }) : t('csv')}
          </button>
        </div>
      </Popover>
      {done ? <span role="status" className="sr-only">{t('exported', { filename: done })}</span> : null}
    </>
  )
}

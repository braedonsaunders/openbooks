'use client'

import { useState } from 'react'
import { ChevronDown, Download, FileText, Sheet } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Popover } from '@openbooks/ui'
import {
  accountRegisterExportHref,
  type AccountRegisterExportFormat,
} from '../lib/account-register-export'

export function AccountRegisterExportMenu({
  accountId,
  from,
  to,
  search,
}: {
  accountId: string
  from?: string | null
  to?: string | null
  search?: string | null
}) {
  const t = useTranslations('reports.export')
  const [open, setOpen] = useState(false)
  const href = (format: AccountRegisterExportFormat) =>
    accountRegisterExportHref(accountId, format, { from, to, search })
  const item =
    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'

  return (
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
        <a className={item} href={href('pdf')} onClick={() => setOpen(false)}>
          <FileText size={14} /> {t('pdf')}
        </a>
        <a className={item} href={href('xlsx')} onClick={() => setOpen(false)}>
          <Sheet size={14} /> {t('xlsx')}
        </a>
        <a className={item} href={href('csv')} onClick={() => setOpen(false)}>
          <Download size={14} /> {t('csv')}
        </a>
      </div>
    </Popover>
  )
}

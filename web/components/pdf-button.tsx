'use client'

// The record "PDF" button — lives in every transaction flyout's headerActions.
// Click prints the record with the org's default template (or the built-in
// starter design). When the org has more than one template for the record
// type, a picker menu opens instead so the user chooses the design.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { FileText } from 'lucide-react'
import { Button, ContextMenu, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'

export function PdfButton({ recordType, recordId }: { recordType: string; recordId: string }) {
  const t = useTranslations('pdfTemplates')
  const menu = useContextMenu()
  const [items, setItems] = useState<ContextMenuEntry[] | null>(null)
  const [busy, setBusy] = useState(false)

  const pdfHref = (templateId?: string) =>
    `/api/record-pdf/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}` +
    (templateId ? `?template=${encodeURIComponent(templateId)}` : '')

  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    const anchor = e.currentTarget
    let entries = items
    if (!entries) {
      setBusy(true)
      try {
        const res = await fetch(`/api/record-pdf/${encodeURIComponent(recordType)}/options`)
        if (!res.ok) {
          toast.error(t('pdfButton.failed'))
          return
        }
        const data = (await res.json()) as { rows: { id: string; name: string; isDefault: boolean }[] }
        entries =
          data.rows.length > 1
            ? data.rows.map((r) => ({
                key: r.id,
                label: r.isDefault ? `${r.name} ★` : r.name,
                onSelect: () => window.open(pdfHref(r.id), '_blank'),
              }))
            : []
        setItems(entries)
      } finally {
        setBusy(false)
      }
    }
    if (entries.length > 0) menu.openBelow(anchor)
    else window.open(pdfHref(), '_blank')
  }

  return (
    <>
      <Button variant="outline" onClick={onClick} disabled={busy}>
        <FileText size={15} className="mr-1.5" />
        {t('pdfButton.label')}
      </Button>
      <ContextMenu open={menu.open} position={menu.position} items={items ?? []} onClose={menu.close} />
    </>
  )
}

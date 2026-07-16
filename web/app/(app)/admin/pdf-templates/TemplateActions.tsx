'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { promptDialog } from '../../../../lib/prompt'

/** Prompt for a name, create the template (starter design), open the editor. */
export function NewTemplateButton({
  recordType,
  asDuplicateOfStarter = false,
}: {
  recordType: string
  asDuplicateOfStarter?: boolean
}) {
  const t = useTranslations('pdfTemplates')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function create() {
    const name = await promptDialog({ title: t('newTemplate') })
    if (!name?.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/pdf-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordType, name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('editor.saveFailed'))
        return
      }
      router.push(`/admin/pdf-templates/${data.id}`)
    } finally {
      setBusy(false)
    }
  }

  return asDuplicateOfStarter ? (
    <button
      onClick={create}
      disabled={busy}
      className="text-sm font-medium text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-300"
    >
      {t('list.duplicate')}
    </button>
  ) : (
    <Button onClick={create} disabled={busy}>
      {t('newTemplate')}
    </Button>
  )
}

/** Copy an existing template (name prompt) and open the copy. */
export function DuplicateTemplateButton({ templateId }: { templateId: string }) {
  const t = useTranslations('pdfTemplates')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function duplicate() {
    setBusy(true)
    try {
      const res = await fetch(`/api/pdf-templates/${templateId}`)
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('editor.saveFailed'))
        return
      }
      const src = data.row
      const name = await promptDialog({ title: t('list.duplicate'), initialValue: `${src.name} (copy)` })
      if (!name?.trim()) return
      const created = await fetch('/api/pdf-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordType: src.recordType,
          name: name.trim(),
          description: src.description,
          sourceHtml: src.sourceHtml,
          headerHtml: src.headerHtml,
          footerHtml: src.footerHtml,
          paperSize: src.paperSize,
          orientation: src.orientation,
          marginMm: src.marginMm,
        }),
      })
      const createdData = await created.json()
      if (!created.ok) {
        toast.error(createdData.error ?? t('editor.saveFailed'))
        return
      }
      router.push(`/admin/pdf-templates/${createdData.id}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={duplicate}
      disabled={busy}
      className="text-sm font-medium text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-300"
    >
      {t('list.duplicate')}
    </button>
  )
}

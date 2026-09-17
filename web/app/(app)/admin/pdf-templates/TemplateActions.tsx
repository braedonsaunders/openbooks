'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { promptDialog } from '../../../../lib/prompt'

/**
 * First non-colliding name: the base when free, else "base 2", "base 3", …
 * Digits only — no translatable words, so no catalog keys are needed. The
 * pdf_templates unique index is (org_id, record_type, name): callers pass the
 * taken names for the new template's own record type (F-t13-001 — the offered
 * default must not collide, or every duplicate-save dies on a 409).
 */
export function uniqueTemplateName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Prompt for a name, create the template (starter design), open the editor. */
export function NewTemplateButton({
  recordType,
  asDuplicateOfStarter = false,
  defaultName,
}: {
  recordType: string
  asDuplicateOfStarter?: boolean
  /** Pre-filled template name (e.g. "Customer invoice starter"). */
  defaultName?: string
}) {
  const t = useTranslations('pdfTemplates')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function create() {
    const name = await promptDialog({ title: t('newTemplate'), initialValue: defaultName })
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
export function DuplicateTemplateButton({
  templateId,
  takenNames,
}: {
  templateId: string;
  /** Names already used by this record type — the offered default skips them. */
  takenNames?: Set<string>;
}) {
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
      const name = await promptDialog({
        title: t('list.duplicate'),
        initialValue: uniqueTemplateName(`${src.name} (copy)`, takenNames ?? new Set([src.name])),
      })
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

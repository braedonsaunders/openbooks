'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Drawer, Select } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { DuplicateTemplateButton, NewTemplateButton, uniqueTemplateName } from './TemplateActions'

export type TemplateRow = {
  id: string
  name: string
  description: string | null
  recordType: string
  paperSize: string
  orientation: string
  isActive: boolean
  isDefault: boolean
};

export interface StarterRow {
  recordType: string
  label: string
  sourceHtml: string
  headerHtml: string
  footerHtml: string
  /** No org template is the type default, so the starter is what prints. */
  isEffectiveDefault: boolean
}

type Row =
  | { kind: 'starter'; starter: StarterRow }
  | { kind: 'template'; template: TemplateRow }

/**
 * The PDF templates list — shared PagedTable (search + pagination) over every
 * record type at once, with a type dropdown filter (default: all). Each type's
 * built-in starter is a row too: click it for a read-only preview drawer
 * rendered with sample data by the same Chromium path the editor uses.
 */
export function TemplatesList({
  templates,
  starters,
  recordTypes,
}: {
  templates: TemplateRow[]
  starters: StarterRow[]
  recordTypes: { key: string; label: string }[]
}) {
  const t = useTranslations('pdfTemplates')
  const tCommon = useTranslations('common')
  const [typeFilter, setTypeFilter] = useState('')
  const [preview, setPreview] = useState<StarterRow | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const labelByType = useMemo(
    () => new Map(recordTypes.map((rt) => [rt.key, rt.label])),
    [recordTypes],
  )

  // Paper-size names come from the catalog (list.paperLetter/paperA4/
  // paperLegal) — an unknown stored size renders verbatim, exactly like an
  // unknown run status in the delivery panel.
  const paperName = (size: string) =>
    size === 'letter'
      ? t('list.paperLetter')
      : size === 'a4'
        ? t('list.paperA4')
        : size === 'legal'
          ? t('list.paperLegal')
          : size

  // Taken names per record type (the unique index is org + type + name), so
  // the offered duplicate default never collides (F-t13-001).
  const takenByType = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const tp of templates) {
      let set = map.get(tp.recordType)
      if (!set) {
        set = new Set<string>()
        map.set(tp.recordType, set)
      }
      set.add(tp.name)
    }
    return map
  }, [templates])

  const rows = useMemo<Row[]>(() => {
    const starterRows = starters
      .filter((s) => !typeFilter || s.recordType === typeFilter)
      .map((starter): Row => ({ kind: 'starter', starter }))
    const templateRows = templates
      .filter((tp) => !typeFilter || tp.recordType === typeFilter)
      .map((template): Row => ({ kind: 'template', template }))
    return [...starterRows, ...templateRows]
  }, [starters, templates, typeFilter])

  useEffect(() => {
    if (!preview) return
    let cancelled = false
    let url: string | null = null
    ;(async () => {
      try {
        const res = await fetch('/api/pdf-templates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordType: preview.recordType,
            sourceHtml: preview.sourceHtml,
            headerHtml: preview.headerHtml,
            footerHtml: preview.footerHtml,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? t('list.previewFailed'))
        }
        url = URL.createObjectURL(await res.blob())
        if (!cancelled) setPreviewUrl(url)
      } catch (e) {
        if (!cancelled) {
          toast.error((e as Error).message)
          setPreview(null)
        }
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      setPreviewUrl(null)
    }
  }, [preview, t])

  const columns: PagedColumn<Row>[] = [
    {
      key: 'name',
      header: t('list.name'),
      search: (row) =>
        row.kind === 'starter'
          ? t('list.starterNamed', { type: row.starter.label })
          : `${row.template.name} ${row.template.description ?? ''}`,
      cell: (row) =>
        row.kind === 'starter' ? (
          <button
            onClick={() => setPreview(row.starter)}
            className="text-left font-medium text-slate-700 hover:underline dark:text-slate-200"
          >
            {t('list.starterNamed', { type: row.starter.label })}
            <span className="ml-2 text-xs font-normal text-slate-400">{t('list.starterHint')}</span>
          </button>
        ) : (
          <>
            <Link
              href={`/admin/pdf-templates/${row.template.id}`}
              className="font-medium text-teal-700 hover:underline dark:text-teal-300"
            >
              {row.template.name}
            </Link>
            {row.template.description ? (
              <span className="ml-2 text-xs text-slate-400">{row.template.description}</span>
            ) : null}
          </>
        ),
    },
    {
      key: 'type',
      header: t('list.type'),
      search: (row) =>
        labelByType.get(row.kind === 'starter' ? row.starter.recordType : row.template.recordType) ?? '',
      cell: (row) => (
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {labelByType.get(row.kind === 'starter' ? row.starter.recordType : row.template.recordType)}
        </span>
      ),
    },
    {
      key: 'status',
      header: tCommon('labels.status'),
      cell: (row) =>
        row.kind === 'starter' ? (
          <>
            <Badge variant="outline">{t('list.builtIn')}</Badge>{' '}
            {row.starter.isEffectiveDefault ? <Badge variant="default">{t('list.isDefault')}</Badge> : null}
          </>
        ) : (
          <>
            <Badge variant={row.template.isActive ? 'success' : 'outline'}>
              {row.template.isActive ? tCommon('labels.active') : tCommon('labels.inactive')}
            </Badge>{' '}
            {row.template.isDefault ? <Badge variant="default">{t('list.isDefault')}</Badge> : null}
          </>
        ),
    },
    {
      key: 'paper',
      header: t('list.paper'),
      cell: (row) => (
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {row.kind === 'starter'
            ? `${paperName('letter')} · ${t('editor.portrait')}`
            : `${paperName(row.template.paperSize)} · ${
                row.template.orientation === 'landscape' ? t('editor.landscape') : t('editor.portrait')
              }`}
        </span>
      ),
    },
    {
      key: 'actions',
      header: tCommon('labels.actions'),
      align: 'right',
      cell: (row) =>
        row.kind === 'starter' ? (
          <NewTemplateButton
            recordType={row.starter.recordType}
            asDuplicateOfStarter
            defaultName={uniqueTemplateName(
              t('list.starterNamed', { type: row.starter.label }),
              takenByType.get(row.starter.recordType) ?? new Set(),
            )}
          />
        ) : (
          <DuplicateTemplateButton
            templateId={row.template.id}
            takenNames={takenByType.get(row.template.recordType)}
          />
        ),
    },
  ]

  return (
    <>
      <PagedTable
        rows={rows}
        columns={columns}
        pageSize={15}
        searchable
        empty={t('list.empty')}
        rowKey={(row) => (row.kind === 'starter' ? `starter-${row.starter.recordType}` : row.template.id)}
        toolbarAfter={
          <div className="flex items-center gap-2">
            <Select
              aria-label={t('list.type')}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-56"
            >
              <option value="">{t('list.allTypes')}</option>
              {recordTypes.map((rt) => (
                <option key={rt.key} value={rt.key}>
                  {rt.label}
                </option>
              ))}
            </Select>
            {typeFilter ? (
              <NewTemplateButton
                recordType={typeFilter}
                defaultName={uniqueTemplateName(
                  t('list.starterNamed', { type: labelByType.get(typeFilter) ?? '' }),
                  takenByType.get(typeFilter) ?? new Set(),
                )}
              />
            ) : null}
          </div>
        }
      />
      <Drawer
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? t('list.starterNamed', { type: preview.label }) : ''}
        description={t('list.previewNote')}
        size="lg"
        bodyClassName="p-0"
      >
        {previewUrl ? (
          <iframe title={t('list.builtInStarter')} src={previewUrl} className="h-full w-full border-0" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            {tCommon('feedback.loading')}
          </div>
        )}
      </Drawer>
    </>
  )
}

import { getTranslations } from 'next-intl/server'
import type { FieldValueMap, FormSection } from '@openbooks/forms-core'
import { BlockList } from '@/components/viewspec/blocks'
import { ListPageLayout } from '@/components/page-layout'
import { buildListDrawerHref, mergeHref, pickString } from '@/lib/list-params'
import { formatFieldValue, isNumericField, listableFields } from '@/lib/record-schema'
import { recordModuleSpec, type RecordModuleData } from '../../records/[typeKey]/view'

/** The native record workspace over local examples, never a tenant query. */
export async function DraftRecordPreview({ sections, typeKey, typeName, title, basePath, searchParams, header }: {
  sections: FormSection[]; typeKey: string; typeName: string; title: string; basePath: string;
  searchParams: Record<string, string | string[] | undefined>; header: React.ReactNode
}) {
  const t = await getTranslations('admin.extensions.native')
  const tr = await getTranslations('records.module')
  const tc = await getTranslations('common')
  const fields = listableFields(sections).slice(0, 5)
  const filters = fields.filter(field => (field.type === 'select' || field.type === 'radio') && field.validation?.options?.length).slice(0, 3)
  const examples = Array.from({ length: 3 }, (_, index) => {
    const values: FieldValueMap = {}
    for (const section of sections) {
      if (section.repeating) continue
      for (const field of section.fields) {
        const choices = field.validation?.options ?? []
        if (choices.length) values[field.id] = field.type === 'multi_select' ? [choices[index % choices.length]!.value] : choices[index % choices.length]!.value
        else if (field.type === 'party' || field.type === 'gl_account') values[field.id] = 'preview-reference'
        else if (field.type === 'date') values[field.id] = `2026-01-${15 + index}`
        else if (field.type === 'datetime') values[field.id] = `2026-01-${15 + index}T09:00`
        else if (['number', 'currency', 'percentage', 'rating'].includes(field.type)) values[field.id] = index + 1
        else if (field.type !== 'formula') values[field.id] = t('sampleValue', { field: field.label, number: index + 1 })
      }
    }
    return { id: `sample-${index + 1}`, number: t('sampleNumber', { number: index + 1 }), values }
  })
  const cells = (values: FieldValueMap) => Object.fromEntries(fields.map(field => [field.id,
    field.type === 'party' || field.type === 'gl_account' ? t('sampleReference') : formatFieldValue(field, values[field.id])]))
  const query = (pickString(searchParams.q) ?? '').toLowerCase()
  const sort = pickString(searchParams.sort) ?? 'number'
  const dir = pickString(searchParams.dir) === 'desc' ? 'desc' : 'asc'
  const rows = examples.filter(row => (!query || [row.number, ...Object.values(cells(row.values))].join(' ').toLowerCase().includes(query))
    && (!pickString(searchParams.status) || searchParams.status === 'draft')
    && filters.every(field => !pickString(searchParams[`f_${field.id}`]) || row.values[field.id] === searchParams[`f_${field.id}`]))
    .map(row => ({ id: row.id, number: row.number, numberHref: buildListDrawerHref(basePath, searchParams, 'rec', row.id), cells: cells(row.values), statusLabel: tc('status.draft'), statusVariant: 'secondary' as const, created: '—' }))
    .sort((a, b) => (sort === 'number' ? a.number.localeCompare(b.number) : (a.cells[sort] ?? '').localeCompare(b.cells[sort] ?? '', undefined, { numeric: true })) * (dir === 'desc' ? -1 : 1))
  const selected = examples.find(row => row.id === searchParams.rec)
  const isNew = searchParams.rec === 'new'
  const closeHref = mergeHref(basePath, searchParams, { rec: undefined, drawerReturn: undefined })
  const data: RecordModuleData = {
    basePath, typeKey, typeName, title, description: '', canCreate: false,
    previewNewHref: buildListDrawerHref(basePath, searchParams, 'rec', 'new'),
    previewNewLabel: tr('newButton', { typeName }),
    newRecordProps: { typeKey, typeName, basePath, currentParams: searchParams },
    searchPlaceholder: tr('searchPlaceholder', { pluralName: title.toLowerCase() }),
    statusLabel: tc('labels.status'), statusOptions: [{ value: 'draft', label: tc('status.draft'), count: 3 }],
    filterChips: filters.map(field => ({ paramKey: `f_${field.id}`, label: field.label, options: (field.validation?.options ?? []).map(option => ({ ...option, count: examples.filter(row => row.values[field.id] === option.value).length })) })),
    currentParams: searchParams, emptyTitle: tr('emptyTitle', { pluralName: title.toLowerCase() }), emptyDescription: '',
    isEmpty: false, hasRows: true,
    columns: fields.map(field => ({ id: field.id, label: field.label, align: isNumericField(field) ? 'right' : 'left' })),
    columnStatus: tc('labels.status'), columnCreated: tc('labels.created'), rows, filteredTotal: rows.length,
    currentPage: 1, perPage: 25, sort, dir,
    drawerOpen: !!selected || isNew,
    drawerProps: selected || isNew ? { remountKey: selected?.id ?? 'new', typeKey, typeName, sections,
      // Preview-only synthetic record: saves are disabled in preview, so no
      // revision exists; the empty token can never satisfy the save guard.
      record: { id: selected?.id ?? 'new', recordNumber: selected?.number ?? tr('newButton', { typeName }), data: selected?.values ?? {}, status: 'draft', updatedAt: '' },
      canEdit: true, preview: true, closeHref } : null,
  }
  const spec = recordModuleSpec(data)
  return <ListPageLayout header={<>{header}<BlockList blocks={spec.header} scope={data} searchParams={searchParams} /></>}>
    <BlockList blocks={spec.body} scope={data} searchParams={searchParams} />
  </ListPageLayout>
}

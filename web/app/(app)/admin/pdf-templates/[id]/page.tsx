import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../../lib/authz'
import { isDocKindEnabled } from '../../../../../lib/documents'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../lib/pdf-templates/catalog'
import { getPdfTemplate } from '../../../../../lib/pdf-templates/store'
import { customMergeFields } from '../../../../../lib/pdf-templates/values'
import PdfTemplateEditor from './PdfTemplateEditor'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('pdfTemplates')
  return { title: t('title') }
}

export default async function PdfTemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const authz = await requirePermission('admin.customization.manage')
  const { id } = await params
  const row = await getPdfTemplate(authz.user.orgId, id)
  if (!row) notFound()
  const meta = PDF_RECORD_TYPE_BY_KEY[row.recordType]
  if (!meta) notFound()
  if (!(await isDocKindEnabled(authz.user.orgId, row.recordType))) notFound()

  const custom = await customMergeFields(row.recordType, authz.user.orgId)
  const mergeFields = [...meta.fields, ...custom].map((f) => ({ key: f.key, label: f.label }))
  const collections = meta.collections.map((c) => ({
    key: c.key,
    label: c.label,
    fields: c.fields.map((f) => ({ key: f.key, label: f.label })),
  }))

  return (
    <div className="p-4">
      <PdfTemplateEditor
        template={{
          id: row.id,
          recordType: row.recordType,
          recordTypeLabel: meta.label,
          name: row.name,
          description: row.description,
          paperSize: row.paperSize,
          orientation: row.orientation,
          marginMm: row.marginMm,
          headerHtml: row.headerHtml,
          footerHtml: row.footerHtml,
          sourceHtml: row.sourceHtml,
          isDefault: row.isDefault,
          isActive: row.isActive,
        }}
        mergeFields={mergeFields}
        collections={collections}
      />
    </div>
  )
}

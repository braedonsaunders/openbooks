import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { PDF_RECORD_TYPES } from '../../../../lib/pdf-templates/catalog'
import { starterTemplate } from '../../../../lib/pdf-templates/starters'
import { listPdfTemplates } from '../../../../lib/pdf-templates/store'
import { TemplatesList, type StarterRow, type TemplateRow } from './TemplatesList'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('pdfTemplates')
  return { title: t('title') }
}

/**
 * PDF templates — every record type in one shared paginated list (search +
 * type dropdown, defaulting to all). Each type's built-in starter is a row:
 * click for a read-only sample-data preview; duplicate to start an org
 * template.
 */
export default async function PdfTemplatesPage() {
  const authz = await requirePermission('admin.customization.manage')
  const t = await getTranslations('pdfTemplates')
  const tHub = await getTranslations('admin.hub')

  const all = await listPdfTemplates(authz.user.orgId)
  const templates: TemplateRow[] = all.map((tp) => ({
    id: tp.id,
    name: tp.name,
    description: tp.description,
    recordType: tp.recordType,
    paperSize: tp.paperSize,
    orientation: tp.orientation,
    isActive: tp.isActive,
    isDefault: tp.isDefault,
  }))
  const defaultedTypes = new Set(all.filter((tp) => tp.isDefault).map((tp) => tp.recordType))
  const starters: StarterRow[] = PDF_RECORD_TYPES.map((meta) => {
    const starter = starterTemplate(meta)
    return {
      recordType: meta.key,
      label: meta.label,
      sourceHtml: starter.sourceHtml,
      headerHtml: starter.headerHtml,
      footerHtml: starter.footerHtml,
      isEffectiveDefault: !defaultedTypes.has(meta.key),
    }
  })

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/admin', label: tHub('title') }}
          title={t('title')}
          description={t('description')}
        />
      }
    >
      <TemplatesList
        templates={templates}
        starters={starters}
        recordTypes={PDF_RECORD_TYPES.map((meta) => ({ key: meta.key, label: meta.label }))}
      />
    </ListPageLayout>
  )
}

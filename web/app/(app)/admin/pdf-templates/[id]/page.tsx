import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPdfTemplateEditor, pdfTemplateEditorSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('pdfTemplates')
  return { title: t('title') }
}

export default async function PdfTemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadPdfTemplateEditor(id)
  return <ModuleView spec={pdfTemplateEditorSpec(data)} data={data} searchParams={sp} trusted />
}

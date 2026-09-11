import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPdfTemplates, pdfTemplatesSpec } from './view'

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
export default async function PdfTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPdfTemplates()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={pdfTemplatesSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

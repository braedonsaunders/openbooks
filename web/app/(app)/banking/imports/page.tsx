import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { bankingImportsSpec, loadBankingImports } from './view'

export const dynamic = 'force-dynamic'


export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('imports.title') }
}

export default async function BankingImports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBankingImports(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={bankingImportsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

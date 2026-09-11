import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadProvisionDetail, provisionDetailSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function TaxProvisionDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional so direct test invocations passing only `params` keep compiling;
  // Next.js always supplies both in production.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const { id } = await params
  const data = await loadProvisionDetail(sp, id)
  return <ModuleView spec={provisionDetailSpec(data)} data={data} searchParams={sp} trusted />
}

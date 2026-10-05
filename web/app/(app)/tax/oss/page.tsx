import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadOss, ossSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Tax → One-Stop-Shop returns. Posted B2C supplies group by member state of
 * consumption and rate, with correction lines for earlier quarters; the
 * generic EU OSS CSV carries every filed figure for portal hand-keying.
 */
export default async function OssPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadOss()
  return <ModuleView spec={ossSpec(data)} data={data} searchParams={sp} trusted />
}

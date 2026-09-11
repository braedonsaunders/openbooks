import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadApCapture, apCaptureSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function ApCapturePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadApCapture(sp)
  return <ModuleView spec={apCaptureSpec(data)} data={data} searchParams={sp} trusted />
}

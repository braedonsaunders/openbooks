import { ModuleView } from '@/components/viewspec/module-view'
import { loadMySchedulePage, myScheduleSpec, myScheduleTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await myScheduleTitle() }
}

/** My schedule — the signed-in person's published bookings. 404s when Scheduling is off. */
export default async function MySchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMySchedulePage(sp)
  return <ModuleView spec={myScheduleSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPspReviews, pspReviewsSpec } from './view'

/**
 * Banking → PSP settlements → Reviews: provider refunds and disputes parked
 * by the review policy, with approve/reject in the row drawer.
 */
export default async function PspReviewsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  const data = await loadPspReviews(sp)
  return <ModuleView spec={pspReviewsSpec(data)} data={data} searchParams={sp} trusted />
}

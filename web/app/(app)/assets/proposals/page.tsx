import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadProposals, proposalsSpec } from "./view";

export const dynamic = "force-dynamic";

/**
 * The asset proposal queue: posted purchase lines the capitalization rules
 * flagged, to accept as assets, components or construction in progress, or
 * reject with a reason.
 */
export default async function AssetProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadProposals(sp);
  return <ModuleView spec={proposalsSpec(data)} data={data} searchParams={sp} trusted />;
}

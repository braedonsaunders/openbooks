import { ModuleView } from "../../../../components/viewspec/module-view";
import { accountMergesSpec, loadAccountMerges } from "./view";

export const dynamic = "force-dynamic";

/** Merge history: executed account merges and open merge proposals. */
export default async function AccountMerges({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadAccountMerges(sp);
  return <ModuleView spec={accountMergesSpec(data)} data={data} searchParams={sp} trusted />;
}

import { ModuleView } from "../../../../components/viewspec/module-view";
import { intercompanyReconciliationSpec, loadIntercompanyReconciliation } from "./view";

export const dynamic = "force-dynamic";

export default async function IntercompanyReconciliationReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadIntercompanyReconciliation(sp);
  return (
    <ModuleView spec={intercompanyReconciliationSpec(data)} data={data} searchParams={sp} trusted />
  );
}

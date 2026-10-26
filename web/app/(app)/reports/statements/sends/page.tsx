import { ModuleView } from "../../../../../components/viewspec/module-view";
import { loadStatementBatchRuns, statementBatchRunsSpec } from "./view";

export const dynamic = "force-dynamic";

/**
 * Statement batch history. The page is a loader and a spec: `./view.ts`
 * resolves the recorded runs, and `ModuleView` renders them; a selected
 * run (?run=) opens its detail drawer beside the list. Authorization
 * lives in the loader — the AR read grant behind the runs.
 */
export default async function StatementBatches({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadStatementBatchRuns(sp);
  return <ModuleView spec={statementBatchRunsSpec(data)} data={data} searchParams={sp} trusted />;
}

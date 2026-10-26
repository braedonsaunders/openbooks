import { ModuleView } from "../../../../../components/viewspec/module-view";
import { loadStatementBatchComposer, statementBatchComposerSpec } from "./view";

export const dynamic = "force-dynamic";

/**
 * The batch composer. The page is a loader and a spec: `./view.ts`
 * resolves the customers a run would send to for the chosen period and
 * filters, and `ModuleView` renders them with the send action.
 * Authorization lives in the loader — reports.read plus the AR grant
 * behind the balances; creating the run additionally needs ar.create.
 */
export default async function SendStatements({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadStatementBatchComposer(sp);
  return (
    <ModuleView spec={statementBatchComposerSpec(data)} data={data} searchParams={sp} trusted />
  );
}

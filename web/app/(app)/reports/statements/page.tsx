import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadStatementPicker, statementPickerSpec } from "./view";

export const dynamic = "force-dynamic";

/**
 * The customer-statement picker. The page is a loader and a spec: `./view.ts`
 * resolves the customer rows (each linking to that customer's statement for
 * the picker's period), and `ModuleView` renders them. Authorization lives in
 * the loader — reports.read plus the AR grant behind the balances.
 */
export default async function CustomerStatements({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadStatementPicker(sp);
  return <ModuleView spec={statementPickerSpec(data)} data={data} searchParams={sp} trusted />;
}

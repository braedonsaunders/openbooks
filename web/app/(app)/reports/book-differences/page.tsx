import { ModuleView } from "../../../../components/viewspec/module-view";
import { requireStatementAccess } from "../../../../lib/report-authz";
import { bookDifferencesSpec, loadBookDifferences } from "./view";

export const dynamic = "force-dynamic";

export default async function BookDifferences({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp0 = await searchParams;
  await requireStatementAccess("book-differences", sp0);
  const data = await loadBookDifferences(sp0);
  return <ModuleView spec={bookDifferencesSpec(data)} data={data} searchParams={sp0} trusted />;
}

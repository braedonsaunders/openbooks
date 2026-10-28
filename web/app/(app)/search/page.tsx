import { ModuleView } from "../../../components/viewspec/module-view";
import { loadSearchPage, searchSpec } from "./view";

export const dynamic = "force-dynamic";

/** Search results: everything the header search finds, one group at a time. */
export default async function SearchResultsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadSearchPage(sp);
  return <ModuleView spec={searchSpec(data)} data={data} searchParams={sp} trusted />;
}

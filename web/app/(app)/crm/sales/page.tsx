import { loadSalesWorkspace } from "@/lib/crm/sales-workspace";
import { ModuleView } from "@/components/viewspec/module-view";
import { page, widgetBlock } from "@braedonsaunders/appkit-viewspec";
export const dynamic = "force-dynamic";
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const data = await loadSalesWorkspace("overview", params);
  return (
    <ModuleView
      spec={page({
        route: "/crm/sales",
        layout: "bare",
        header: [],
        body: [widgetBlock("crm-sales-workspace", { data, params })],
      })}
      data={{}}
      searchParams={params}
      trusted
    />
  );
}

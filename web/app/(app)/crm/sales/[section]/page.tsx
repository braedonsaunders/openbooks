import { notFound } from "next/navigation";
import { loadSalesWorkspace } from "@/lib/crm/sales-workspace";
import type { SalesPage } from "@openbooks/engine/crm/sales/contracts";
import { ModuleView } from "@/components/viewspec/module-view";
import { page, widgetBlock } from "@braedonsaunders/appkit-viewspec";
export const dynamic = "force-dynamic";
export default async function SalesSection({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { section } = await params;
  if (!["representatives", "teams", "quotas", "territories"].includes(section))
    notFound();
  const sp = await searchParams;
  const data = await loadSalesWorkspace(section as SalesPage, sp);
  return (
    <ModuleView
      spec={page({
        route: `/crm/sales/${section}`,
        layout: "bare",
        header: [],
        body: [widgetBlock("crm-sales-workspace", { data, params: sp })],
      })}
      data={{}}
      searchParams={sp}
      trusted
    />
  );
}

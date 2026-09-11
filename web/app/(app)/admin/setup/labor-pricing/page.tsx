import { ModuleView } from "../../../../../components/viewspec/module-view"
import { loadLaborPricing, laborPricingSpec } from "./view"

export const dynamic = "force-dynamic";

export default async function LaborPricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadLaborPricing(sp);
  if (!data) return null;
  return (
    <ModuleView
      spec={laborPricingSpec(data)}
      data={data}
      searchParams={sp}
      trusted
    />
  );
}

import { ModuleView } from "../../../../components/viewspec/module-view";
import { insuranceSpec, loadInsurance } from "./view";

export const dynamic = "force-dynamic";

/** Asset insurance: policies, covered assets, renewals and insured value against net book value. */
export default async function AssetInsurancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadInsurance(sp);
  return <ModuleView spec={insuranceSpec(data)} data={data} searchParams={sp} trusted />;
}

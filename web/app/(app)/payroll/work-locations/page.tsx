import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadWorkLocations, workLocationsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("payroll");
  return { title: t.has("workLocations.title" as never) ? t("workLocations.title" as never) : "Payroll work locations" };
}

export default async function PayrollWorkLocationsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams;
  const data = await loadWorkLocations();
  return <ModuleView spec={workLocationsSpec(data)} data={data} searchParams={sp} trusted />;
}

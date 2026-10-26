import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadAccountingChanges, accountingChangesSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("accounting");
  return { title: t("lifecycle.pageTitle") };
}

export default async function AccountingEvents({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadAccountingChanges(sp);
  return <ModuleView spec={accountingChangesSpec(data)} data={data} searchParams={sp} trusted />;
}

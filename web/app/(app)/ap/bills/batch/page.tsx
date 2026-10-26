import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../../components/viewspec/module-view";
import { batchBillEntrySpec, loadBatchBillEntry } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("batchEntry");
  return { title: t("title") };
}

export default async function BatchBillEntryPage() {
  const data = await loadBatchBillEntry();
  return <ModuleView spec={batchBillEntrySpec(data)} data={data} searchParams={{}} trusted />;
}

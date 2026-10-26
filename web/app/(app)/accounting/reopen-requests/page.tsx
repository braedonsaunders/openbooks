import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadReopenRequests, reopenRequestsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("accounting.reopenRequests");
  return { title: t("title") };
}

export default async function ReopenRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadReopenRequests(sp);
  return <ModuleView spec={reopenRequestsSpec(data)} data={data} searchParams={sp} trusted />;
}

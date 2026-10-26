import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadTransfersPage, transfersSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("intercompany");
  return { title: t("transfers.title") };
}

/**
 * Bank transfers between entities — gated by Company Settings → Features →
 * Intercompany netting under Multi-subsidiary.
 */
export default async function IntercompanyTransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadTransfersPage(sp);
  return <ModuleView spec={transfersSpec(data)} data={data} searchParams={sp} trusted />;
}

import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { intercompanyPairingSpec, loadIntercompanyPairingPage } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("intercompany");
  return { title: t("title") };
}

/**
 * Intercompany pairing — gated by Company Settings → Features →
 * Intercompany transactions under Multi-subsidiary.
 */
export default async function IntercompanyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadIntercompanyPairingPage(sp);
  return <ModuleView spec={intercompanyPairingSpec(data)} data={data} searchParams={sp} trusted />;
}

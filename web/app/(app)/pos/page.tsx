import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { loadPosRegisters, posRegistersSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("pos");
  return { title: t("picker.title") };
}

/** Customers → Register: choose the register to sell from. */
export default async function PosPage({
  searchParams,
}: {
  // Optional: this route natively takes no query string.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const data = await loadPosRegisters();
  return <ModuleView spec={posRegistersSpec(data)} data={data} searchParams={sp} trusted />;
}

import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadPosRegister, posRegisterSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("pos");
  return { title: t("register.title") };
}

/** One register's full-viewport selling surface. */
export default async function PosRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ registerId: string }>;
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { registerId } = await params;
  const sp = (await searchParams) ?? {};
  const data = await loadPosRegister(registerId);
  return <ModuleView spec={posRegisterSpec(data)} data={data} searchParams={sp} trusted />;
}

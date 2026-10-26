import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { contractorWithholdingSpec, loadContractorWithholding } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("ap.withholding");
  return { title: t("title") };
}

export default async function ContractorWithholdingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadContractorWithholding(sp);
  return (
    <ModuleView spec={contractorWithholdingSpec(data)} data={data} searchParams={sp} trusted />
  );
}

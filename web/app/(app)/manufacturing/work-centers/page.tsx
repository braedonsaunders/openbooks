import {
  ManufacturingWorkspacePage,
  type SearchParams,
} from "../WorkspacePage";
import { getTranslations } from "next-intl/server";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await getTranslations("manufacturing");
  return { title: t("titles.work-centers") };
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <ManufacturingWorkspacePage
      view="work-centers"
      searchParams={await searchParams}
    />
  );
}

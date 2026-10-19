import { SecurityPanel } from "./security-panel";
import { useTranslations } from "next-intl";
import { PageHeader } from "@openbooks/ui";
import { DetailPageLayout } from "../../../../components/page-layout";

/** Shared security page content for the native route and widget registry. */
export function SecurityPageContent() {
  const t = useTranslations("shell.securityPage");
  return (
    <DetailPageLayout header={<PageHeader title={t("title")} description={t("description")} />}>
      <SecurityPanel />
    </DetailPageLayout>
  );
}

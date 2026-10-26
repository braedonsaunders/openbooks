import "server-only";

import { getTranslations } from "next-intl/server";
import { isFeatureEnabled } from "../../../lib/features";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { buildTaxWorkspaceTabs, type TaxWorkspaceSection } from "./workspace-tabs-state";

export type { TaxWorkspaceSection } from "./workspace-tabs-state";

export async function taxWorkspaceTabs(
  orgId: string,
  active: TaxWorkspaceSection,
): Promise<ModuleHomeTab[]> {
  const [t, crossBorderTaxEnabled] = await Promise.all([
    getTranslations("tax"),
    isFeatureEnabled(orgId, "crossBorderTax"),
  ]);
  return buildTaxWorkspaceTabs(active, crossBorderTaxEnabled, {
    filings: t("title"),
    oss: t("oss.title"),
    provisions: t("provisions.title"),
  });
}

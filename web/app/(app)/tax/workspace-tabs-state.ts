import type { ModuleHomeTab } from "@/components/module-home/tab-types";

export type TaxWorkspaceSection = "filings" | "oss" | "provisions";

export function buildTaxWorkspaceTabs(
  active: TaxWorkspaceSection,
  crossBorderTaxEnabled: boolean,
  labels: { filings: string; oss: string; provisions: string },
): ModuleHomeTab[] {
  return [
    { href: "/tax", label: labels.filings, active: active === "filings" },
    ...(crossBorderTaxEnabled
      ? [{ href: "/tax/oss", label: labels.oss, active: active === "oss" }]
      : []),
    { href: "/tax/provisions", label: labels.provisions, active: active === "provisions" },
  ];
}

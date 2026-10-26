import type { ModuleHomeTab } from "../../../../components/module-home/tab-types";
import { mergeHref, pickString } from "../../../../lib/list-params";

export type InformationReturnsView = "filings" | "readiness";

export function informationReturnsViewState(
  sp: Record<string, string | string[] | undefined>,
  readinessCount: number,
  labels: { filings: string; readiness: string },
): { view: InformationReturnsView; tabs: ModuleHomeTab[] } {
  const requested = pickString(sp.view);
  const view: InformationReturnsView = requested === "readiness" ? "readiness" : "filings";
  return {
    view,
    tabs: [
      {
        href: mergeHref("/compliance/information-returns", sp, { view: "filings" }),
        label: labels.filings,
        active: view === "filings",
      },
      {
        href: mergeHref("/compliance/information-returns", sp, { view: "readiness" }),
        label: labels.readiness,
        active: view === "readiness",
        ...(readinessCount > 0 ? { count: readinessCount } : {}),
      },
    ],
  };
}

export function informationReturnFilingHref(
  sp: Record<string, string | string[] | undefined>,
  filingId: string,
): string {
  return mergeHref("/compliance/information-returns", sp, { view: "filings", filing: filingId });
}

export function informationReturnDrawerCloseHref(
  sp: Record<string, string | string[] | undefined>,
): string {
  return mergeHref("/compliance/information-returns", sp, { filing: undefined });
}

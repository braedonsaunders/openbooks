import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";

export type OssScheme = "union" | "non_union" | "ioss";
export type OssEvidenceTab = "return" | "conflicts" | "fx" | "threshold";

export interface OssUrlState {
  scheme: OssScheme;
  from: string;
  to: string;
  tab: OssEvidenceTab;
}

export type OssPeriodDefaults = Record<OssScheme, Pick<OssUrlState, "from" | "to">>;

const SCHEMES = new Set<OssScheme>(["union", "non_union", "ioss"]);
const TABS = new Set<OssEvidenceTab>(["return", "conflicts", "fx", "threshold"]);

export function readOssUrlState(params: URLSearchParams, defaults: OssPeriodDefaults): OssUrlState {
  const rawScheme = params.get("scheme");
  const rawTab = params.get("tab");
  const from = params.get("from");
  const to = params.get("to");
  const scheme =
    rawScheme && SCHEMES.has(rawScheme as OssScheme) ? (rawScheme as OssScheme) : "union";
  return {
    scheme,
    from: from && isIsoCalendarDate(from) ? from : defaults[scheme].from,
    to: to && isIsoCalendarDate(to) ? to : defaults[scheme].to,
    tab: rawTab && TABS.has(rawTab as OssEvidenceTab) ? (rawTab as OssEvidenceTab) : "return",
  };
}

export function mergeOssUrlState(current: string, updates: Partial<OssUrlState>): string {
  const params = new URLSearchParams(current);
  for (const key of ["scheme", "from", "to", "tab"] as const) {
    const value = updates[key];
    if (value === undefined) continue;
    params.set(key, value);
  }
  return params.toString();
}

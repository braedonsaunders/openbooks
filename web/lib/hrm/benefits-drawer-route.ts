import { isUuid } from "@openbooks/engine/platform/identifiers";

export const BENEFITS_PROGRAM_DRAWER_PARAMS = [
  "program",
  "edit",
  "setupTab",
  "transactionTab",
  "participantsPage",
  "activityPage",
  "simulate",
  "periodFrom",
  "periodTo",
] as const;

export function isBenefitsProgramDrawerSelection(params: URLSearchParams): boolean {
  return (
    isUuid(params.get("program") ?? "") &&
    !["award", "plan", "transactionRules", "window"].some((key) => params.has(key))
  );
}

export function benefitsProgramCloseHref(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  for (const key of BENEFITS_PROGRAM_DRAWER_PARAMS) next.delete(key);
  return `/hrm/benefits${next.size ? `?${next}` : ""}`;
}

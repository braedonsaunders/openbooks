/**
 * The setup surface that resolves a manufacturing readiness refusal, by its
 * refusal code. Readiness views (the operating setup journey and a draft
 * work order's release readiness) link each unmet prerequisite through this
 * one map so they always send the operator to the same place.
 */
export function setupEditorHref(code: string, fallback: string): string {
  if (code.startsWith("component_")) return "/items";
  if (code.startsWith("machine_rate")) return "/manufacturing/work-centers";
  if (code.startsWith("mfg") || code.startsWith("laborClearing")) return "/admin/setup/company";
  if (code.startsWith("work_center")) return "/manufacturing/work-centers";
  if (code.startsWith("standard_overhead")) return "/admin/setup/overhead";
  if (code.includes("fx")) return "/admin/setup/fx-provider";
  if (code.startsWith("standard_labor")) return "/admin/setup/labor-costing";
  if (code.startsWith("routing")) return "/manufacturing/routings";
  return fallback;
}

/**
 * One-line description under a finding's title, shared by the
 * /continuous-close screen and the /agents workbench so the two lists can
 * never describe the same finding differently.
 */
export function findingSummaryLine(
  t: (key: string, values?: Record<string, string | number>) => string,
  summary: Record<string, unknown>,
): string {
  if (summary.accountName)
    return [summary.accountNumber, summary.accountName].filter(Boolean).join(" · ");
  if (summary.scenarioName) return String(summary.scenarioName);
  if (summary.currentPeriod) return `${summary.currentPeriod} / ${summary.priorPeriod}`;
  if (summary.count != null) return t("summary.records", { count: Number(summary.count) });
  return t("summary.review");
}

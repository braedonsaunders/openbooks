import "server-only";

import { getTranslations } from "next-intl/server";
import { toUnits } from "@openbooks/engine/money/money";
import { intercompanyReconciliation, type ReconciliationRow } from "@openbooks/engine/intercompany";
import type { ExportData } from "./report-pdf";

/**
 * Intercompany reconciliation as the flat report shape every export engine
 * reads: one section per intercompany pair, two rows per currency (one per
 * entity, each with its intercompany receivable, payable and due-to/due-from
 * position, owed-to-entity positive) and the difference between them. The
 * screen, PDF, XLSX and CSV all render this one shape.
 */
export async function intercompanyReconciliationExportData(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  asOfDate: string,
  dateRangeLabel: string,
): Promise<ExportData> {
  const t = await getTranslations("intercompany");
  const rows = await intercompanyReconciliation(orgId, allowedSubsidiaryIds, { asOfDate });
  const byPair = new Map<string, ReconciliationRow[]>();
  for (const row of rows) byPair.set(row.pairId, [...(byPair.get(row.pairId) ?? []), row]);
  const columns = [
    t("reconciliation.columns.currency"),
    t("reconciliation.columns.entity"),
    t("reconciliation.columns.receivable"),
    t("reconciliation.columns.payable"),
    t("reconciliation.columns.position"),
    t("reconciliation.columns.net"),
    t("reconciliation.columns.functionalNet"),
  ];
  const unreconciled = rows.filter((row) => toUnits(row.difference) !== 0n).length;
  return {
    title: t("reconciliation.title"),
    dateRangeLabel,
    summary: [
      { label: t("reconciliation.summary.balances"), value: rows.length },
      { label: t("reconciliation.summary.unreconciled"), value: unreconciled },
    ],
    groups: [...byPair.values()].map((pairRows) => {
      const first = pairRows[0]!;
      return {
        kind: "section" as const,
        title: `${first.from.subsidiaryName} ↔ ${first.to.subsidiaryName}`,
        columns,
        align: ["left", "left", "right", "right", "right", "right", "right"],
        money: [false, false, true, true, true, true, true],
        rows: pairRows.flatMap((row) => [
          [
            row.currency,
            row.from.subsidiaryName,
            row.from.receivable,
            row.from.payable,
            row.from.position,
            row.from.net,
            `${row.from.functionalNet} ${row.from.functionalCurrency}`,
          ],
          [
            row.currency,
            row.to.subsidiaryName,
            row.to.receivable,
            row.to.payable,
            row.to.position,
            row.to.net,
            `${row.to.functionalNet} ${row.to.functionalCurrency}`,
          ],
          [row.currency, t("reconciliation.difference"), "", "", "", row.difference, ""],
        ]),
      };
    }),
  };
}

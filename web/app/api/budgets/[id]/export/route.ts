import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { loadBudgetExportData } from "@openbooks/engine/budgets/export-read";
import { reportResultToCsv, reportResultToXlsx, type ReportRunResult } from "@openbooks/office";
import { xlsxMoneyContext } from "@/lib/xlsx-money";
import { can } from "@/lib/authz";
import { csvResponse, xlsxResponse } from "@/lib/export";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "budgets.read",
  feature: "budgets",
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    if (!can(gate, "data.export"))
      return NextResponse.json({ error: "missing permission: data.export" }, { status: 403 });
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const format = new URL(req.url).searchParams.get("format") ?? "xlsx";
    if (!["csv", "xlsx"].includes(format))
      return NextResponse.json({ error: "invalid_format" }, { status: 422 });
    const data = await loadBudgetExportData({
      orgId: gate.user.orgId,
      scenarioId: id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    if (!data) return notFound("record");
    const { scenario, lines, segments } = data;
    // Custom segments (fund included) export one column each, named for the
    // segment and holding the value's code (name when it has none), which is
    // what the import resolves — so a fund budget round-trips to its fund.
    const segmentLabel = (key: string, valueId: string | undefined) => {
      const value = valueId
        ? segments
            .find((segment) => segment.key === key)
            ?.values.find((option) => option.id === valueId)
        : undefined;
      return value ? (value.code ?? value.name) : (valueId ?? "");
    };
    const result: ReportRunResult = {
      groups: [
        {
          kind: "results",
          title: scenario.name,
          columns: [
            "Account Number",
            "Account Name",
            "Period",
            "Subsidiary",
            "Department",
            "Project",
            "Location",
            "Class",
            ...segments.map((segment) => segment.name),
            "Amount",
            "Note",
          ],
          rows: lines.map((row) => [
            row.number ?? "",
            row.account_name,
            row.period,
            row.subsidiary ?? "",
            row.department ?? "",
            row.project ?? "",
            row.location ?? "",
            row.class ?? "",
            ...segments.map((segment) => segmentLabel(segment.key, row.extra_dims?.[segment.key])),
            row.amount,
            row.note ?? "",
          ]),
          isEmpty: lines.length === 0,
        },
      ],
      summary: [],
      rowCount: lines.length,
    };
    const stamp = await businessToday(gate.user.orgId);
    const filename = `${scenario.name}-${scenario.fiscal_year}-${stamp}`;
    if (format === "csv") return csvResponse(reportResultToCsv(result), filename);
    return xlsxResponse(
      await reportResultToXlsx(result, {
        reportName: scenario.name,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
        money: await xlsxMoneyContext(gate.user.orgId),
      }),
      filename,
    );
  },
});

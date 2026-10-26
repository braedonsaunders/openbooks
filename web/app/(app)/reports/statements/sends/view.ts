import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "../../../../../lib/format";
import {
  column,
  field,
  link,
  ref,
  table,
  text,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../../lib/authz";
import { statementReportSpec } from "@/lib/reports/statement-report-spec";
import { orgInfo } from "../../../../../lib/data";
import { listStatementBatchRuns } from "@openbooks/engine/receivables/statement-batches";

/**
 * Statement batch history: every run with its period, recipient count,
 * and per-customer delivery tallies. A selected run (?run=) opens its
 * detail drawer beside the list.
 */

export interface StatementBatchRunListRow {
  rowKey: string;
  created: string;
  period: string;
  recipients: string;
  sent: string;
  failed: string;
  failedTone: "default" | "negative";
  skipped: string;
  status: string;
  href: string;
}

export interface StatementBatchRunsData {
  title: string;
  backHref: string;
  backLabel: string;
  company: string;
  periodPhrase: string;
  columnCreated: string;
  columnPeriod: string;
  columnRecipients: string;
  columnSent: string;
  columnFailed: string;
  columnSkipped: string;
  columnStatus: string;
  rows: StatementBatchRunListRow[];
  hasRows: boolean;
  emptyTitle: string;
  emptyHint: string;
  selectedRunId: string | null;
}

function pickString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function loadStatementBatchRuns(
  sp: Record<string, string | string[] | undefined>,
): Promise<StatementBatchRunsData> {
  const authz = await requirePermission("ar.read");
  const tp = await getTranslations("reports.statementBatch");
  const locale = await getLocale();
  const tr = await getTranslations("reports");
  const org = await orgInfo();

  const runs = await listStatementBatchRuns(authz.user.orgId, { limit: 25 });
  const statusLabel = (status: string): string => {
    if (status === "done") return tp("statusDone");
    if (status === "sending") return tp("statusSending");
    return tp("statusQueued");
  };
  return {
    title: tp("sendsTitle"),
    backHref: "/reports/statements",
    backLabel: tr("statementsPicker.title"),
    company: org?.name ?? "",
    periodPhrase: tp("periodDefault"),
    columnCreated: tp("columnCreated"),
    columnPeriod: tp("columnPeriod"),
    columnRecipients: tp("columnRecipients"),
    columnSent: tp("columnSent"),
    columnFailed: tp("columnFailed"),
    columnSkipped: tp("columnSkipped"),
    columnStatus: tp("columnStatus"),
    rows: runs.map((run) => {
      const created = new Date(run.createdAt);
      const stamp = `${created.toISOString().slice(0, 10)} ${created.toISOString().slice(11, 16)}`;
      return {
        rowKey: run.id,
        created: stamp,
        period: run.periodFrom
          ? tp("periodRange", civilDateParams({ from: run.periodFrom, to: run.periodTo }, locale))
          : run.periodTo,
        recipients: String(run.recipientCount),
        sent: String(run.sent),
        failed: String(run.failed),
        failedTone: run.failed > 0 ? "negative" : "default",
        skipped: String(run.skipped),
        status: statusLabel(run.status),
        href: `/reports/statements/sends?run=${run.id}`,
      };
    }),
    hasRows: runs.length > 0,
    emptyTitle: tp("sendsEmptyTitle"),
    emptyHint: tp("sendsEmptyHint"),
    selectedRunId: pickString(sp.run) ?? null,
  };
}

const f = ref<StatementBatchRunsData>();
const row = field;

export function statementBatchRunsSpec(data: StatementBatchRunsData): PageSpec {
  return statementReportSpec({
    route: "/reports/statements/sends",
    header: { title: f("title"), back: { href: f("backHref"), label: f("backLabel") } },
    saveView: false,
    paper: {
      company: f("company"),
      title: f("title"),
      periodPhrase: f("periodPhrase"),
    },
    bodyBeforePaper: [
      ...(!data.hasRows
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.emptyTitle ?? "",
                description: data.emptyHint,
              }),
            },
          ]
        : []),
    ],
    blocks: [
      table({
        variant: "report",
        rows: f("rows"),
        rowKey: row("rowKey"),
        columns: [
          column(f("columnCreated"), link(row("created"), row("href"))),
          column(f("columnPeriod"), text(row("period"))),
          column(f("columnRecipients"), text(row("recipients")), { align: "right" }),
          column(f("columnSent"), text(row("sent")), { align: "right" }),
          column(f("columnFailed"), text(row("failed")), { align: "right" }),
          column(f("columnSkipped"), text(row("skipped")), { align: "right" }),
          column(f("columnStatus"), text(row("status"))),
        ],
      }),
      widgetBlock("statement-batch-run-drawer", { runId: data.selectedRunId }),
    ],
  });
}

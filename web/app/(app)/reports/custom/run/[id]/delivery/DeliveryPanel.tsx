"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Badge, Button } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { useViewerFormat } from "@/lib/viewer-format";
import { readApiErrorMessage } from "../../../../../../../lib/api-error";
import { ScheduleEditor, type ScheduleRow } from "../../../../ScheduleEditor";

export type RunRow = {
  id: string;
  trigger: string;
  status: string;
  error: string | null;
  row_count: number | null;
  started_at: string | null;
  finished_at: string | null;
  artifact_available: boolean;
  delivery_total: number;
  delivery_sent: number;
  delivery_failed: number;
  delivery_suppressed: number;
};

const RUN_VARIANT: Record<string, "success" | "warning" | "secondary" | "outline"> = {
  succeeded: "success",
  running: "warning",
  queued: "secondary",
  failed: "outline",
};

// Message keys under reports.custom.runner — unknown enum values render verbatim.
const RUN_STATUS_KEY: Record<string, string> = {
  succeeded: "status.succeeded",
  running: "status.running",
  queued: "status.queued",
  failed: "status.failed",
};
const RUN_TRIGGER_KEY: Record<string, string> = {
  manual: "trigger.manual",
  scheduled: "trigger.scheduled",
};

/** Schedules + recorded run history for one definition (management surface). */
export function DeliveryPanel({
  definitionId,
  schedules,
  recentRuns,
  canSchedule,
}: {
  definitionId: string;
  schedules: ScheduleRow[];
  recentRuns: RunRow[];
  canSchedule: boolean;
}) {
  const t = useTranslations("reports.custom.runner");
  const tk = useTranslations("reports.custom");
  const tc = useTranslations("common");
  const router = useRouter();
  const viewerFormat = useViewerFormat();
  const [running, setRunning] = useState(false);

  // Records a run row + CSV artifact — the report screen itself never does.
  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch("/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definitionId }),
      });
      // The status is checked before the body is parsed: a non-JSON error
      // body must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("runFailed")));
      toast.success(t("runComplete"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("runFailed"));
    } finally {
      setRunning(false);
    }
    router.refresh();
  }

  async function downloadArtifact(url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("runFailed")));
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download =
        res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/i)?.[1] ?? "report";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("runFailed"));
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("scheduledDelivery")}
        </h2>
        <ScheduleEditor
          definitionId={definitionId}
          schedules={schedules}
          canSchedule={canSchedule}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t("recentRuns")}
          </h2>
          <Button size="sm" variant="outline" disabled={running} onClick={runNow}>
            <Play size={15} /> {running ? tk("running") : t("runNow")}
          </Button>
        </div>
        <PagedTable<RunRow>
          source="report_delivery_runs"
          rows={recentRuns}
          rowKey={(run) => run.id}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t("emptyHint")}</p>}
          columns={[
            {
              key: "status",
              header: tc("labels.status"),
              cell: (run) => (
                <>
                  <Badge variant={RUN_VARIANT[run.status] ?? "secondary"}>
                    {RUN_STATUS_KEY[run.status] ? t(RUN_STATUS_KEY[run.status]!) : run.status}
                  </Badge>
                  {run.error ? (
                    <span className="ml-2 text-xs text-red-600 dark:text-red-400">{run.error}</span>
                  ) : null}
                </>
              ),
              search: (run) => `${run.status} ${run.error ?? ""}`,
            },
            {
              key: "trigger",
              header: t("columns.trigger"),
              cell: (run) =>
                RUN_TRIGGER_KEY[run.trigger] ? t(RUN_TRIGGER_KEY[run.trigger]!) : run.trigger,
              search: (run) => run.trigger,
            },
            { key: "rows", header: t("columns.rows"), cell: (run) => run.row_count ?? "—" },
            {
              key: "finished",
              header: t("columns.finished"),
              cell: (run) =>
                run.finished_at ? viewerFormat.dateTime(new Date(run.finished_at)) : "—",
            },
            {
              key: "delivery",
              header: t("columns.delivery"),
              cell: (run) =>
                run.trigger !== "scheduled"
                  ? "—"
                  : t("deliveryEvidence", {
                      sent: run.delivery_sent,
                      total: run.delivery_total,
                      failed: run.delivery_failed,
                      suppressed: run.delivery_suppressed,
                    }),
            },
            {
              key: "download",
              header: tc("actions.download"),
              cell: (run) =>
                run.artifact_available ? (
                  <button
                    type="button"
                    onClick={() => void downloadArtifact(`/api/reports/runs/${run.id}/artifact`)}
                    className="text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {t("pdf")}
                  </button>
                ) : run.status === "succeeded" && run.row_count != null ? (
                  <button
                    type="button"
                    onClick={() => void downloadArtifact(`/api/reports/runs/${run.id}/csv`)}
                    className="text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {t("csv")}
                  </button>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </section>
    </div>
  );
}

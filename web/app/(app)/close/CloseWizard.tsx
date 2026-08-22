"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PageHeader,
  Textarea,
  cn,
} from "@openbooks/ui";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FilePlus2,
  GitBranch,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { WizardLayout } from "../../../components/page-layout";

type Row = Record<string, any>;
type Props = {
  run: Row;
  tasks: Row[];
  exceptions: Row[];
  evidence: Row[];
  signoffs: Row[];
  events: Row[];
  locks: Row[];
  stage?: string;
  canRun: boolean;
  canApprove: boolean;
  canReopen: boolean;
  canManageFlows: boolean;
  subsidiaryEnabled: boolean;
  multiCurrency: boolean;
  advancedClose: boolean;
};

const STAGES = [
  "scope",
  "readiness",
  "execute",
  "review",
  "lock",
  "publish",
] as const;
type Stage = (typeof STAGES)[number];

async function call(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
}

export function CloseWizard(props: Props) {
  const t = useTranslations("close");
  const router = useRouter();
  const selected: Stage = STAGES.includes(props.stage as Stage)
    ? (props.stage as Stage)
    : (props.run.current_stage as Stage);
  const completed = props.tasks.filter((task) =>
    ["complete", "waived"].includes(task.status),
  ).length;
  const progress = props.tasks.length
    ? Math.round((completed / props.tasks.length) * 100)
    : 0;
  const critical = props.tasks
    .filter(
      (task) =>
        !["complete", "waived"].includes(task.status) &&
        task.predicted_days != null,
    )
    .sort((a, b) => b.predicted_days - a.predicted_days)[0];
  const [busy, setBusy] = useState(false);

  async function runAction(action: string, comment?: string) {
    setBusy(true);
    try {
      await call(`/api/close/runs/${props.run.id}`, { action, comment });
      toast.success(t(`messages.${action}`));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link
            href="/close"
            className="mt-1 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label={t("actions.backToPeriods")}
          >
            <ArrowLeft size={18} />
          </Link>
          <PageHeader
            title={t("runTitle", { period: props.run.period_name })}
            description={t("runDescription", {
              book: props.run.book_name,
              blueprint: taskText(t, props.run.blueprint_name),
              version: props.run.blueprint_version,
            })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              props.run.status === "published" || props.run.status === "closed"
                ? "success"
                : "warning"
            }
          >
            {t(`runStatus.${props.run.status}`)}
          </Badge>
          {props.canRun ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => runAction("refresh")}
            >
              <RefreshCw size={14} />
              {t("actions.revalidate")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label={t("metrics.readiness")}
          value={`${props.run.readiness_score}%`}
          note={t("metrics.liveLedger")}
        />
        <Metric
          label={t("metrics.progress")}
          value={`${progress}%`}
          note={t("metrics.tasksComplete", {
            completed,
            total: props.tasks.length,
          })}
        />
        <Metric
          label={t("metrics.criticalPath")}
          value={critical ? taskText(t, critical.title) : t("metrics.clear")}
          note={
            critical
              ? t("metrics.historicalDays", { days: critical.predicted_days })
              : t("metrics.noPredictedBlocker")
          }
        />
      </div>
      <nav
        className="flex gap-1 overflow-x-auto"
        aria-label={t("stageNavigation")}
      >
        {STAGES.map((stage, index) => (
          <Link
            key={stage}
            href={`/close?run=${props.run.id}&stage=${stage}` as any}
            className={cn(
              "flex min-w-28 flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
              selected === stage
                ? "border-teal-300 bg-teal-50 font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300"
                : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60",
            )}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-xs dark:bg-slate-800">
              {index + 1}
            </span>
            {t(`stages.${stage}`)}
          </Link>
        ))}
      </nav>
    </div>
  );

  return (
    <WizardLayout wide header={header}>
      {props.run.last_validated_at ? (
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Sparkles size={14} className="text-teal-500" />
          <span>
            {t("continuousValidation", {
              at: formatCloseTimestamp(props.run.last_validated_at),
            })}
          </span>
          <code className="ml-auto hidden max-w-44 truncate rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800 sm:block">
            {props.run.data_fingerprint}
          </code>
        </div>
      ) : null}
      {selected === "scope" ? <ScopeStage {...props} /> : null}
      {selected === "readiness" ? (
        <ReadinessStage
          {...props}
          busy={busy}
          onRefresh={() => runAction("refresh")}
        />
      ) : null}
      {selected === "execute" ? (
        <TaskStage
          {...props}
          tasks={props.tasks.filter(
            (task) =>
              !["review", "publish"].includes(task.workstream) &&
              !task.key.startsWith("lock-"),
          )}
        />
      ) : null}
      {selected === "review" ? (
        <TaskStage
          {...props}
          tasks={props.tasks.filter((task) => task.workstream === "review")}
        />
      ) : null}
      {selected === "lock" ? (
        <LockStage {...props} busy={busy} onAction={runAction} />
      ) : null}
      {selected === "publish" ? (
        <PublishStage {...props} busy={busy} onAction={runAction} />
      ) : null}
    </WizardLayout>
  );
}

function taskText(
  t: ReturnType<typeof useTranslations>,
  value: string | null | undefined,
): string {
  if (!value) return "";
  return value.startsWith("close.") ? t(value.slice(6) as any) : value;
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      <p className="truncate text-xs text-slate-400">{note}</p>
    </div>
  );
}

function ScopeStage(props: Props) {
  const t = useTranslations("close");
  const subsidiaryIds = props.run.scope?.subsidiaryIds ?? [];
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <Card>
        <CardHeader>
          <CardTitle>{t("scope.title")}</CardTitle>
          <CardDescription>{t("scope.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Detail
            label={t("scope.period")}
            value={`${props.run.period_name} · ${props.run.starts_on} → ${props.run.ends_on}`}
          />
          <Detail label={t("scope.book")} value={props.run.book_name} />
          <Detail
            label={t("scope.blueprint")}
            value={`${taskText(t, props.run.blueprint_name)} v${props.run.blueprint_version}`}
          />
          <Detail
            label={t("scope.target")}
            value={props.run.target_close_date}
          />
          {props.subsidiaryEnabled ? (
            <Detail
              label={t("scope.entities")}
              value={
                subsidiaryIds.length
                  ? t("scope.selectedEntities", { count: subsidiaryIds.length })
                  : t("scope.allEntities")
              }
            />
          ) : null}
          <Detail
            label={t("scope.package")}
            value={taskText(t, props.run.package_name) || t("scope.noPackage")}
          />
        </CardContent>
      </Card>
      <Card className="border-violet-200 bg-gradient-to-br from-violet-50 to-white dark:border-violet-900 dark:from-violet-950/30 dark:to-slate-900">
        <CardHeader>
          <div className="flex items-center gap-2 text-violet-700 dark:text-violet-300">
            <Bot size={18} />
            <CardTitle className="text-base">{t("rehearsal.title")}</CardTitle>
          </div>
          <CardDescription>{t("rehearsal.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href={
              `/admin/sandboxes?new=1&mode=as_of&periodId=${props.run.period_id}` as any
            }
          >
            <Button variant="outline">
              <Play size={15} />
              {t("rehearsal.action")}
              <ExternalLink size={13} />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-sm text-slate-900 dark:text-slate-100">{value}</p>
    </div>
  );
}

function ReadinessStage(
  props: Props & { busy: boolean; onRefresh: () => void },
) {
  const t = useTranslations("close");
  const open = props.exceptions.filter((item) => item.status === "open");
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <Card>
          <CardContent className="flex flex-col items-center p-6">
            <div
              className="relative flex h-36 w-36 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(rgb(20 184 166) ${props.run.readiness_score}%, rgb(226 232 240) 0)`,
              }}
            >
              <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-white dark:bg-slate-900">
                <span className="text-3xl font-semibold tabular-nums">
                  {props.run.readiness_score}%
                </span>
                <span className="text-xs text-slate-500">
                  {t("readiness.score")}
                </span>
              </div>
            </div>
            <Button
              className="mt-5"
              variant="outline"
              disabled={props.busy || !props.canRun}
              onClick={props.onRefresh}
            >
              <RefreshCw size={14} />
              {t("actions.revalidate")}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("readiness.title")}</CardTitle>
            <CardDescription>{t("readiness.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {open.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-4 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                <CheckCircle2 />
                <span>{t("readiness.clear")}</span>
              </div>
            ) : (
              <div className="space-y-2">
                {open.map((item) => (
                  <ExceptionRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ExceptionRow({ item }: { item: Row }) {
  const t = useTranslations("close");
  const critical = ["critical", "error"].includes(item.severity);
  const actionHref = closeExceptionActionHref(item.code);
  const values = { count: Number(item.details?.count ?? 0) };
  const title = item.title?.startsWith("close.")
    ? t(item.title.slice(6) as any, values)
    : item.title;
  const message = item.message?.startsWith("close.")
    ? t(item.message.slice(6) as any, values)
    : item.message;
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3",
        critical
          ? "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20"
          : "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20",
      )}
    >
      <AlertTriangle
        size={17}
        className={critical ? "mt-0.5 text-red-600" : "mt-0.5 text-amber-600"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-slate-900 dark:text-slate-100">
            {title}
          </p>
          <Badge variant={critical ? "destructive" : "warning"}>
            {t(`severity.${item.severity}`)}
          </Badge>
        </div>
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
        {actionHref ? (
          <Link href={actionHref as any} className="mt-3 inline-flex">
            <Button size="sm" variant="outline">
              {t("actions.resolveException")}
              <ExternalLink size={13} />
            </Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function closeExceptionActionHref(code: string): string | null {
  const actions: Record<string, string> = {
    "drafts-open": "/journal",
    "posting-period-missing": "/journal",
    "bank-unreconciled": "/banking",
    "depreciation-unposted": "/assets",
    "fx-missing": "/admin/setup/fx-rates",
    "fx-unrevalued": "/admin/setup/fx-rates",
    "intercompany-residual": "/reports/trial-balance",
    "material-variances": "/reports/pnl",
  };
  return actions[code] ?? null;
}

function TaskStage(props: Props & { tasks: Row[] }) {
  const t = useTranslations("close");
  const groups = useMemo(
    () => Array.from(new Set(props.tasks.map((task) => task.workstream))),
    [props.tasks],
  );
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group} className="space-y-3">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-teal-600" />
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">
              {t(`workstreams.${group}` as any)}
            </h3>
          </div>
          <div className="space-y-3">
            {props.tasks
              .filter((task) => task.workstream === group)
              .map((task) => (
                <TaskCard key={task.id} {...props} task={task} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskCard(props: Props & { task: Row }) {
  const t = useTranslations("close");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const taskEvidence = props.evidence.filter(
    (item) => item.task_id === props.task.id,
  );
  const openException = props.exceptions.find(
    (item) => item.task_id === props.task.id && item.status === "open",
  );
  const actionHref = closeTaskActionHref(props.task, props.run);
  async function action(actionName: string) {
    setBusy(true);
    try {
      await call(`/api/close/runs/${props.run.id}/tasks/${props.task.id}`, {
        action: actionName,
        notes: note || undefined,
      });
      toast.success(t("messages.taskUpdated"));
      setNote("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function addEvidence() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await call(`/api/close/runs/${props.run.id}/evidence`, {
        taskId: props.task.id,
        evidenceType: "note",
        label: note.trim(),
        snapshot: { note: note.trim() },
      });
      toast.success(t("messages.evidenceAdded"));
      setNote("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function runRevaluation() {
    setBusy(true);
    try {
      await call("/api/close/run-revaluation", {
        periodId: props.run.period_id,
      });
      toast.success(t("messages.revaluationPosted"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function runConsolidation() {
    setBusy(true);
    try {
      await call("/api/consolidation", {
        action: "consolidate",
        periodId: props.run.period_id,
      });
      toast.success(t("messages.consolidationPosted"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      className={cn(
        props.task.status === "blocked" && "opacity-65",
        props.task.status === "invalidated" && "border-amber-300",
      )}
    >
      <CardHeader className="p-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <StatusIcon status={props.task.status} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">
                  {taskText(t, props.task.title)}
                </CardTitle>
                <Badge
                  variant={
                    props.task.gate_type === "hard"
                      ? "destructive"
                      : props.task.gate_type === "soft"
                        ? "warning"
                        : "outline"
                  }
                >
                  {t(`gates.${props.task.gate_type}`)}
                </Badge>
              </div>
              <CardDescription>
                {taskText(t, props.task.description)}
              </CardDescription>
            </div>
          </div>
          <div className="text-right text-xs text-slate-500">
            <Badge
              variant={
                props.task.status === "complete"
                  ? "success"
                  : props.task.status === "blocked"
                    ? "outline"
                    : "warning"
              }
            >
              {t(`taskStatus.${props.task.status}`)}
            </Badge>
            <p className="mt-1">
              <Clock3 size={12} className="mr-1 inline" />
              {props.task.due_on}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {props.task.dependencies?.length ? (
          <p className="text-xs text-slate-500">
            {t("tasks.dependencies", {
              dependencies: props.task.dependencies.join(", "),
            })}
          </p>
        ) : null}
        {openException ? <ExceptionRow item={openException} /> : null}
        {taskEvidence.length ? (
          <div className="flex flex-wrap gap-2">
            {taskEvidence.map((item) => (
              <Badge key={item.id} variant="outline">
                <FileCheck2 size={12} />
                {item.label}
              </Badge>
            ))}
          </div>
        ) : null}
        {props.canRun &&
        props.multiCurrency &&
        props.task.key === "fx-revalued" &&
        !["complete", "waived"].includes(props.task.status) ? (
          <Button size="sm" disabled={busy} onClick={runRevaluation}>
            <Play size={14} />
            {t("actions.runRevaluation")}
          </Button>
        ) : null}
        {props.canRun &&
        props.subsidiaryEnabled &&
        props.task.key === "consolidation" &&
        !["complete", "waived"].includes(props.task.status) ? (
          <Button size="sm" disabled={busy} onClick={runConsolidation}>
            <Play size={14} />
            {t("actions.runConsolidation")}
          </Button>
        ) : null}
        {actionHref &&
        !["complete", "waived"].includes(props.task.status) &&
        !["fx-revalued", "consolidation"].includes(props.task.key) ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={actionHref as any}>
              <ExternalLink size={14} />
              {t("actions.takeAction")}
            </Link>
          </Button>
        ) : null}
        {props.canRun &&
        !["complete", "waived"].includes(props.task.status) &&
        props.task.completion_mode === "manual" &&
        props.task.task_type !== "approval" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-52 flex-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("tasks.notePlaceholder")}
            />
            {props.task.evidence_required ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !note.trim()}
                onClick={addEvidence}
              >
                <FilePlus2 size={14} />
                {t("actions.addEvidence")}
              </Button>
            ) : null}
            {["ready", "invalidated", "changes_requested"].includes(
              props.task.status,
            ) ? (
              <Button size="sm" disabled={busy} onClick={() => action("start")}>
                <Play size={14} />
                {t("actions.startTask")}
              </Button>
            ) : null}
            {props.task.status === "in_progress" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  action(props.task.reviewer_id ? "submit" : "complete")
                }
              >
                <Send size={14} />
                {props.task.reviewer_id
                  ? t("actions.submitReview")
                  : t("actions.complete")}
              </Button>
            ) : null}
            {props.task.status === "submitted" && props.canApprove ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => action("approve")}
                >
                  <Check size={14} />
                  {t("actions.approve")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => action("request_changes")}
                >
                  <RotateCcw size={14} />
                  {t("actions.requestChanges")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function closeTaskActionHref(task: Row, run: Row): string | null {
  if (task.task_type === "approval") return "/approvals";
  const exact: Record<string, string> = {
    "drafts-cleared": "/journal",
    "bank-reconciled": "/banking/reconciliations",
    "ar-cutoff": "/ar",
    "ap-cutoff": "/ap",
    "depreciation-posted": "/assets",
    "fx-ready": "/admin/setup/fx-rates",
    "intercompany-balanced": "/reports/trial-balance",
    consolidation: "/reports/trial-balance",
    "variance-review": `/reports/pnl?period=custom&from=${run.starts_on}&to=${run.ends_on}`,
    "financial-review": `/reports/trial-balance?period=custom&from=${run.starts_on}&to=${run.ends_on}`,
    "controller-approval": "/approvals",
    "publish-package": `/close?run=${run.id}&stage=publish`,
  };
  if (exact[task.key]) return exact[task.key];
  const workstream: Record<string, string> = {
    readiness: `/close?run=${run.id}&stage=readiness`,
    banking: "/banking/reconciliations",
    ar: "/ar",
    ap: "/ap",
    assets: "/assets",
    tax: "/tax",
    payroll: "/timesheets",
    intercompany: "/journal",
    gl: "/journal",
    review: "/reports",
    publish: `/close?run=${run.id}&stage=publish`,
  };
  return workstream[task.workstream] ?? null;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "complete")
    return (
      <div className="rounded-full bg-emerald-100 p-1.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <Check size={16} />
      </div>
    );
  if (status === "invalidated")
    return (
      <div className="rounded-full bg-amber-100 p-1.5 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <RefreshCw size={16} />
      </div>
    );
  if (status === "blocked")
    return (
      <div className="rounded-full bg-slate-100 p-1.5 text-slate-400 dark:bg-slate-800">
        <LockKeyhole size={16} />
      </div>
    );
  return (
    <div className="rounded-full bg-teal-100 p-1.5 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
      <Clock3 size={16} />
    </div>
  );
}

function LockStage(
  props: Props & {
    busy: boolean;
    onAction: (action: string, comment?: string) => void;
  },
) {
  const t = useTranslations("close");
  const rootLocks = props.locks.filter((lock) => !lock.subsidiary_id);
  const [attestation, setAttestation] = useState("");
  const blockers = props.tasks.filter(
    (task) =>
      task.gate_type === "hard" &&
      task.task_type !== "approval" &&
      task.completion_mode !== "automatic" &&
      !["complete", "waived"].includes(task.status),
  );
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="text-teal-600" />
            <CardTitle>{t("lock.title")}</CardTitle>
          </div>
          <CardDescription>{t("lock.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {["ar", "ap", "banking", "assets", "tax", "gl"].map((module) => {
              const lock = rootLocks.find((item) => item.module === module);
              return (
                <div
                  key={module}
                  className="flex items-center justify-between rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <span className="font-medium">{t(`modules.${module}`)}</span>
                  <Badge
                    variant={
                      lock?.state === "closed"
                        ? "success"
                        : lock?.state === "soft_closed"
                          ? "warning"
                          : "outline"
                    }
                  >
                    {t(`lockStates.${lock?.state ?? "open"}`)}
                  </Badge>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      {blockers.length ? (
        <Alert variant="destructive">
          <AlertTriangle size={16} />
          <div>
            <p className="font-medium">{t("lock.blockedTitle")}</p>
            <p>{t("lock.blockedDescription", { count: blockers.length })}</p>
          </div>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t(props.advancedClose ? "lock.approvalTitle" : "lock.ownerTitle")}</CardTitle>
          <CardDescription>{t(props.advancedClose ? "lock.approvalDescription" : "lock.ownerDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!props.advancedClose && props.run.status === "in_progress" ? (
            <div className="space-y-2">
              <label htmlFor="close-owner-attestation" className="text-sm font-medium text-slate-800 dark:text-slate-100">{t("lock.attestationLabel")}</label>
              <Textarea id="close-owner-attestation" value={attestation} onChange={(event) => setAttestation(event.target.value)}
                placeholder={t("lock.attestationPlaceholder")} maxLength={1000} />
              <Button disabled={props.busy || blockers.length > 0 || !props.canApprove || attestation.trim().length < 10}
                onClick={() => props.onAction("attest", attestation.trim())}>
                <ShieldCheck size={15} />{t("actions.attest")}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
          {props.advancedClose && props.run.status === "in_progress" ? (
            <Button
              disabled={props.busy || blockers.length > 0 || !props.canRun}
              onClick={() => props.onAction("request_approval")}
            >
              <ShieldCheck size={15} />
              {t("actions.requestApproval")}
            </Button>
          ) : null}
          {props.run.status === "review" ? (
            <Button variant="outline" asChild>
              <Link href="/approvals">
                <ShieldCheck size={15} />
                {t("actions.reviewApprovals")}
              </Link>
            </Button>
          ) : null}
          {props.run.status === "approved" ? (
            <Button
              disabled={props.busy || !props.canApprove}
              onClick={() => window.confirm(t("lock.confirmLock")) && props.onAction("close")}
            >
              <LockKeyhole size={15} />
              {t("actions.lockPeriod")}
            </Button>
          ) : null}
          {props.run.status === "closed" || props.run.status === "published" ? (
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={18} />
              {t("lock.complete", { name: props.run.closer_name ?? "" })}
            </div>
          ) : null}
          {props.advancedClose && props.canManageFlows ? (
            <Button variant="ghost" asChild>
              <Link href="/admin/flows?subject=close_run">
                <GitBranch size={15} />
                {t("actions.configureApprovalFlow")}
              </Link>
            </Button>
          ) : null}
          <Button variant="ghost" asChild>
            <Link href="/docs/period-close">
              <FileCheck2 size={15} />
              {t("actions.documentation")}
            </Link>
          </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PublishStage(
  props: Props & {
    busy: boolean;
    onAction: (action: string, comment?: string) => void;
  },
) {
  const t = useTranslations("close");
  const reportHref: Record<string, string> = {
    "balance-sheet": "/reports/balance-sheet",
    pnl: "/reports/pnl",
    "cash-flow": "/reports/cash-flow",
    "trial-balance": "/reports/trial-balance",
    "general-ledger": "/reports/general-ledger",
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>
              {taskText(t, props.run.package_name) || t("publish.package")}
            </CardTitle>
            <CardDescription>{t("publish.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(props.run.package_reports ?? []).map((report: string) => (
              <Link
                key={report}
                href={(reportHref[report] ?? "/reports") as any}
                className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm font-medium hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
              >
                <span className="flex items-center gap-2">
                  <FileCheck2 size={15} className="text-teal-600" />
                  {t(`reports.${report}` as any)}
                </span>
                <ExternalLink size={13} />
              </Link>
            ))}
          </CardContent>
        </Card>
        {props.run.status !== "published" ? (
          <div className="space-y-2">
            <Button
              disabled={props.busy || !props.canRun || props.run.status !== "closed"}
              onClick={() => window.confirm(t("publish.confirm")) && props.onAction("publish")}
            >
              <Send size={15} />
              {t("actions.publish")}
            </Button>
            {props.run.status !== "closed" ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {props.run.status === "approved"
                  ? t("publish.lockFirst")
                  : t("publish.awaitingApproval")}
              </p>
            ) : null}
          </div>
        ) : (
          <Card className="border-emerald-200 dark:border-emerald-900">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 />
                {t("publish.complete", {
                  name: props.run.publisher_name ?? "",
                })}
              </div>
              <a
                href={`/api/close/runs/${props.run.id}/binder`}
                className="inline-flex items-center gap-2 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                <Download size={15} />
                {t("actions.downloadBinder")}
              </a>
              {props.run.binder_hash ? (
                <p className="break-all font-mono text-[11px] text-slate-400">
                  SHA-256 {props.run.binder_hash}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("timeline.title")}</CardTitle>
          <CardDescription>{t("timeline.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {props.events.map((event) => (
              <div
                key={event.id}
                className="relative border-l border-slate-200 pl-4 text-sm dark:border-slate-700"
              >
                <span className="absolute -left-1.5 top-1 h-3 w-3 rounded-full border-2 border-white bg-teal-500 dark:border-slate-900" />
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {t.has(`events.${event.event_type}`)
                    ? t(`events.${event.event_type}` as any)
                    : event.event_type}
                </p>
                <p className="text-xs text-slate-500">
                  {event.actor_name ?? t("timeline.system")} ·{" "}
                  {formatCloseTimestamp(event.at)}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatCloseTimestamp(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

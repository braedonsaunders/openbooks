"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Eye,
  FileText,
  LayoutGrid,
  MessageSquareWarning,
  Rows3,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  Textarea,
  cn,
} from "@openbooks/ui";
import { useBusinessToday } from "../../../../components/business-date-provider";
import { useMoney } from "../../../../components/money-provider";
import { PagedTable } from "../../../../components/paged-table";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { decimalSum } from "../../../../lib/statement-format";
import { PREBILL_STAGES, type PrebillStage } from "../../../../lib/pre-billing-stages";
import type {
  BillRunResult,
  PrebillDetail,
  PrebillListRow,
  UnbilledProjectRow,
} from "../../../../lib/pre-billing";
import { PrebillDrawer } from "./PrebillDrawer";

type ProjectOption = {
  id: string;
  name: string;
  customerName: string | null;
  projectTypeName: string;
  lineBuilder: string;
};

type BoardColumn = PrebillStage | "unbilled";

/** Stages that stay off the board until something reaches them. */
const ON_DEMAND: ReadonlySet<BoardColumn> = new Set(["review", "customer", "sent"]);
/** Closed stages show their most recent cards; the table lists every one. */
const CLOSED_CARD_LIMIT = 12;

export const STAGE_TONE: Record<PrebillStage, "secondary" | "warning" | "default" | "success" | "outline" | "destructive"> = {
  draft: "secondary",
  review: "warning",
  ready: "default",
  customer: "warning",
  invoiced: "default",
  sent: "default",
  paid: "success",
  void: "outline",
};

export async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await readApiErrorMessage(response, "Request failed"));
  return (await response.json()) as T;
}

/**
 * Pre-billing: unbilled work becomes a reviewed, approved — and where the
 * customer is asked, accepted — package before it becomes an invoice, then
 * the invoice is delivered with its backup and tracked to payment.
 *
 * One concept, two views of it: a board whose columns are the stages work
 * moves through, and a single table filtered by stage. Stages that a company
 * does not use (approval routing, customer review) stay hidden until a
 * worksheet reaches them, so a small business sees draft → ready → invoiced.
 */
export function PreBillingWorkspace({
  prebills,
  unbilled,
  projects,
  selected,
  canManage,
  canCreateInvoice,
  customerPortalEnabled,
  approvalFlowsConfigured,
}: {
  prebills: PrebillListRow[];
  unbilled: UnbilledProjectRow[];
  projects: ProjectOption[];
  selected: PrebillDetail | null;
  canManage: boolean;
  canCreateInvoice: boolean;
  customerPortalEnabled: boolean;
  approvalFlowsConfigured: boolean;
}) {
  const t = useTranslations("projects.preBilling");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { money } = useMoney();
  const view = searchParams.get("view") === "table" ? "table" : "board";
  const stageParam = searchParams.get("stage");
  const stageFilter = stageParam && (PREBILL_STAGES as readonly string[]).includes(stageParam)
    ? (stageParam as PrebillStage)
    : null;
  const [query, setQuery] = useState("");
  const [billRunOpen, setBillRunOpen] = useState(false);
  const [billRunProject, setBillRunProject] = useState<string | null>(null);

  function navigate(params: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(params)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const needle = query.trim().toLowerCase();
  const matches = (text: Array<string | null | undefined>) =>
    !needle || text.some((value) => value?.toLowerCase().includes(needle));
  const visiblePrebills = prebills.filter((row) =>
    matches([row.worksheetNumber, row.projectName, row.customerName, row.invoiceNumber]),
  );
  const visibleUnbilled = unbilled.filter((row) => matches([row.projectName, row.customerName]));

  const byStage = useMemo(() => {
    const groups = new Map<PrebillStage, PrebillListRow[]>();
    for (const stage of PREBILL_STAGES) groups.set(stage, []);
    for (const row of visiblePrebills) groups.get(row.stage)!.push(row);
    return groups;
  }, [visiblePrebills]);

  const columns: BoardColumn[] = (["unbilled", ...PREBILL_STAGES.filter((stage) => stage !== "void")] as BoardColumn[])
    .filter((column) => {
      if (!ON_DEMAND.has(column)) return true;
      if (column === "review") return approvalFlowsConfigured || (byStage.get("review")?.length ?? 0) > 0;
      if (column === "customer") return customerPortalEnabled || (byStage.get("customer")?.length ?? 0) > 0;
      return (byStage.get(column as PrebillStage)?.length ?? 0) > 0;
    });

  const nothingYet = prebills.length === 0 && unbilled.length === 0;

  function openBillRun(projectId: string | null) {
    setBillRunProject(projectId);
    setBillRunOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            aria-label={t("toolbar.search")}
            placeholder={t("toolbar.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs font-medium dark:border-slate-800 dark:bg-slate-900">
          {(["board", "table"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={view === mode}
              onClick={() => navigate({ view: mode === "board" ? null : "table" })}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors",
                view === mode
                  ? "bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
              )}
            >
              {mode === "board" ? <LayoutGrid className="size-3.5" /> : <Rows3 className="size-3.5" />}
              {mode === "board" ? t("toolbar.board") : t("toolbar.table")}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          {canManage ? (
            <Button onClick={() => openBillRun(null)} disabled={unbilled.length === 0}>
              <Sparkles className="mr-2 size-4" />
              {t("toolbar.billRun")}
            </Button>
          ) : null}
        </div>
      </div>

      {nothingYet ? (
        <EmptyState
          icon={<FileText />}
          title={projects.length === 0 ? t("empty.noProjectsTitle") : t("empty.nothingToBillTitle")}
          description={projects.length === 0 ? t("empty.noProjectsDescription") : t("empty.nothingToBillDescription")}
          action={projects.length === 0 && canManage ? (
            <Button asChild variant="outline">
              <Link href="/admin/setup/project-types">{t("empty.configureProjectTypes")}</Link>
            </Button>
          ) : undefined}
        />
      ) : view === "board" ? (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2" role="list" aria-label={t("board.aria")}>
          {columns.map((column) => (
            <BoardLane
              key={column}
              column={column}
              rows={column === "unbilled" ? [] : byStage.get(column)!}
              unbilled={column === "unbilled" ? visibleUnbilled : []}
              money={money}
              canManage={canManage}
              onOpen={(id) => navigate({ prebill: id })}
              onPrebill={(projectId) => openBillRun(projectId)}
              onShowAll={(stage) => navigate({ view: "table", stage })}
            />
          ))}
        </div>
      ) : (
        <PrebillTable
          rows={visiblePrebills}
          stage={stageFilter}
          onStage={(stage) => navigate({ stage })}
          onOpen={(id) => navigate({ prebill: id })}
          selectedId={selected?.id ?? null}
          money={money}
        />
      )}

      {billRunOpen ? (
        <BillRunDrawer
          unbilled={unbilled}
          initialProjectId={billRunProject}
          money={money}
          onClose={() => setBillRunOpen(false)}
          onFinished={(firstId) => {
            setBillRunOpen(false);
            router.refresh();
            if (firstId) navigate({ prebill: firstId });
          }}
        />
      ) : null}

      {selected ? (
        <PrebillDrawer
          prebill={selected}
          canManage={canManage}
          canCreateInvoice={canCreateInvoice}
          customerPortalEnabled={customerPortalEnabled}
          onClose={() => navigate({ prebill: null })}
        />
      ) : null}
    </div>
  );
}

function BoardLane({
  column,
  rows,
  unbilled,
  money,
  canManage,
  onOpen,
  onPrebill,
  onShowAll,
}: {
  column: BoardColumn;
  rows: PrebillListRow[];
  unbilled: UnbilledProjectRow[];
  money: (value: string) => string;
  canManage: boolean;
  onOpen: (id: string) => void;
  onPrebill: (projectId: string) => void;
  onShowAll: (stage: PrebillStage) => void;
}) {
  const t = useTranslations("projects.preBilling");
  const closed = column === "paid";
  const shown = closed ? rows.slice(0, CLOSED_CARD_LIMIT) : rows;
  const count = column === "unbilled" ? unbilled.length : rows.length;
  const total = column === "unbilled"
    ? decimalSum(unbilled.map((row) => row.unbilledAmount))
    : decimalSum(rows.map((row) => row.proposedBillAmount));
  return (
    <section
      role="listitem"
      aria-label={t(`stages.${column}`)}
      className="flex w-72 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40"
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t(`stages.${column}`)}
          <span className="rounded-full bg-white px-1.5 text-xs tabular-nums text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
            {count}
          </span>
        </h3>
        <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">{money(total)}</span>
      </header>
      <div className="flex max-h-[calc(100vh-16rem)] min-h-24 flex-col gap-2 overflow-y-auto p-2">
        {count === 0 ? (
          <p className="px-1 py-3 text-xs text-slate-500 dark:text-slate-400">{t(`stageEmpty.${column}`)}</p>
        ) : column === "unbilled" ? (
          unbilled.map((row) => (
            <UnbilledCard key={row.projectId} row={row} money={money} canManage={canManage} onPrebill={onPrebill} />
          ))
        ) : (
          shown.map((row) => <PackageCard key={row.id} row={row} money={money} onOpen={onOpen} />)
        )}
        {closed && rows.length > shown.length ? (
          <button
            type="button"
            onClick={() => onShowAll(column as PrebillStage)}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-teal-700 hover:bg-white dark:text-teal-300 dark:hover:bg-slate-800"
          >
            {t("board.showAll", { count: rows.length })}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function UnbilledCard({
  row,
  money,
  canManage,
  onPrebill,
}: {
  row: UnbilledProjectRow;
  money: (value: string) => string;
  canManage: boolean;
  onPrebill: (projectId: string) => void;
}) {
  const t = useTranslations("projects.preBilling");
  const today = useBusinessToday();
  const ageDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(row.oldestWorkDate)) / 86_400_000));
  return (
    <article className="rounded-lg border border-dashed border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
      <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{row.customerName ?? row.projectName}</p>
      <p className="truncate text-xs text-slate-500 dark:text-slate-400">{row.projectName}</p>
      <p className="mt-2 text-lg font-semibold tabular-nums text-slate-950 dark:text-slate-50">{money(row.unbilledAmount)}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className={cn(
          "inline-flex items-center gap-1 text-xs",
          ageDays > 60 ? "text-red-600 dark:text-red-400" : ageDays > 30 ? "text-amber-700 dark:text-amber-300" : "text-slate-500",
        )}>
          <CalendarClock className="size-3.5" />
          {t("card.oldest", { days: ageDays })}
        </span>
        {canManage ? (
          <Button size="sm" variant="outline" onClick={() => onPrebill(row.projectId)}>
            {t("card.prebill")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function PackageCard({ row, money, onOpen }: { row: PrebillListRow; money: (value: string) => string; onOpen: (id: string) => void }) {
  const t = useTranslations("projects.preBilling");
  const disputed = row.stage === "draft" && row.customerDecision === "disputed";
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className={cn(
        "group w-full rounded-lg border bg-white p-3 text-left shadow-sm transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:bg-slate-950",
        disputed ? "border-red-200 dark:border-red-900" : "border-slate-200 dark:border-slate-800",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{row.customerName ?? row.projectName}</p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{row.projectName}</p>
        </div>
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {row.invoiceNumber ?? row.worksheetNumber}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold tabular-nums text-slate-950 dark:text-slate-50">
        {money(row.stage === "invoiced" || row.stage === "sent" || row.stage === "paid"
          ? row.invoiceTotal ?? row.proposedBillAmount
          : row.proposedBillAmount)}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {row.periodStart ? t("card.period", { start: row.periodStart, end: row.periodEnd }) : t("card.through", { date: row.periodEnd })}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline">{t("card.lines", { count: row.lineCount })}</Badge>
        {row.heldLineCount > 0 ? <Badge variant="warning">{t("card.held", { count: row.heldLineCount })}</Badge> : null}
        {disputed ? (
          <Badge variant="destructive">
            <MessageSquareWarning className="mr-1 size-3" />
            {t("card.disputed", { count: row.disputedLineCount })}
          </Badge>
        ) : null}
        {row.customerDecision === "accepted" && row.stage !== "draft" ? (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 size-3" />
            {row.customerPoNumber ? t("card.acceptedPo", { po: row.customerPoNumber }) : t("card.accepted")}
          </Badge>
        ) : null}
        {row.customerReviewRequired && row.customerDecision !== "accepted" && (row.stage === "draft" || row.stage === "review" || row.stage === "ready") ? (
          <Badge variant="secondary">{t("card.reviewRequired")}</Badge>
        ) : null}
        {row.stage === "customer" && row.customerViewedAt ? (
          <Badge variant="secondary">
            <Eye className="mr-1 size-3" />
            {t("card.viewed")}
          </Badge>
        ) : null}
        {row.stage === "invoiced" && row.invoiceStatus !== "posted" ? (
          <Badge variant="secondary">{t("card.invoiceDraft")}</Badge>
        ) : null}
        {row.stage === "invoiced" && row.invoiceStatus === "posted" ? (
          <Badge variant="default">
            <Send className="mr-1 size-3" />
            {t("card.readyToSend")}
          </Badge>
        ) : null}
        {row.stage === "sent" && row.invoiceOpenBalance ? (
          <Badge variant="outline">{t("card.open", { amount: money(row.invoiceOpenBalance) })}</Badge>
        ) : null}
      </div>
    </button>
  );
}

function PrebillTable({
  rows,
  stage,
  onStage,
  onOpen,
  selectedId,
  money,
}: {
  rows: PrebillListRow[];
  stage: PrebillStage | null;
  onStage: (stage: string | null) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  money: (value: string) => string;
}) {
  const t = useTranslations("projects.preBilling");
  const counts = new Map<PrebillStage, number>();
  for (const row of rows) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);
  // "All" is every stage still in motion; closed stages are their own filters.
  const filtered = stage ? rows.filter((row) => row.stage === stage) : rows.filter((row) => row.stage !== "paid" && row.stage !== "void");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("table.stageFilter")}>
        <FilterChip active={stage === null} onClick={() => onStage(null)} label={t("table.allOpen")} />
        {PREBILL_STAGES.filter((value) => (counts.get(value) ?? 0) > 0 || value === stage).map((value) => (
          <FilterChip
            key={value}
            active={stage === value}
            onClick={() => onStage(value)}
            label={t(`stages.${value}`)}
            count={counts.get(value) ?? 0}
          />
        ))}
      </div>
      <PagedTable
        source="projects_prebills"
        rows={filtered}
        rowKey={(row) => row.id}
        emptyAsRow
        onRowClick={(row) => onOpen(row.id)}
        rowSelected={(row) => row.id === selectedId}
        empty={<EmptyState icon={<FileText />} title={t("table.emptyTitle")} description={t("table.emptyDescription")} />}
        columns={[
          {
            key: "worksheet",
            header: t("table.worksheet"),
            cell: (row) => (
              <>
                <p className="font-medium">{row.worksheetNumber}</p>
                {row.invoiceNumber ? <p className="text-xs text-slate-500">{row.invoiceNumber}</p> : null}
              </>
            ),
          },
          {
            key: "customer",
            header: t("table.customer"),
            cell: (row) => (
              <>
                <p>{row.customerName ?? "—"}</p>
                <p className="text-xs text-slate-500">{row.projectName}</p>
              </>
            ),
          },
          {
            key: "period",
            header: t("table.period"),
            cell: (row) => (
              <span className="whitespace-nowrap text-sm">
                {row.periodStart ? t("card.period", { start: row.periodStart, end: row.periodEnd }) : t("card.through", { date: row.periodEnd })}
              </span>
            ),
          },
          {
            key: "stage",
            header: t("table.stage"),
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-1">
                <Badge variant={STAGE_TONE[row.stage]}>{t(`stages.${row.stage}`)}</Badge>
                {row.stage === "draft" && row.customerDecision === "disputed" ? (
                  <AlertTriangle className="size-4 text-red-600" aria-label={t("card.disputed", { count: row.disputedLineCount })} />
                ) : null}
              </span>
            ),
          },
          {
            key: "amount",
            header: t("table.amount"),
            align: "right",
            className: "tabular-nums",
            cell: (row) => money(row.invoiceTotal ?? row.proposedBillAmount),
          },
          {
            key: "balance",
            header: t("table.openBalance"),
            align: "right",
            className: "tabular-nums",
            cell: (row) => (row.invoiceStatus === "posted" && row.invoiceOpenBalance ? money(row.invoiceOpenBalance) : "—"),
          },
        ]}
      />
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-200"
          : "border-slate-300 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300",
      )}
    >
      {label}
      {typeof count === "number" ? <span className="tabular-nums text-slate-500">{count}</span> : null}
    </button>
  );
}

function BillRunDrawer({
  unbilled,
  initialProjectId,
  money,
  onClose,
  onFinished,
}: {
  unbilled: UnbilledProjectRow[];
  initialProjectId: string | null;
  money: (value: string) => string;
  onClose: () => void;
  onFinished: (firstPrebillId: string | null) => void;
}) {
  const t = useTranslations("projects.preBilling");
  const today = useBusinessToday();
  const [periodEnd, setPeriodEnd] = useState(today);
  const [periodStart, setPeriodStart] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialProjectId ? [initialProjectId] : unbilled.map((row) => row.projectId)),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BillRunResult | null>(null);
  const allSelected = selectedIds.size === unbilled.length;

  function toggle(projectId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  async function run() {
    setBusy(true);
    try {
      const outcome = await requestJson<BillRunResult>("/api/pre-billing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodEnd,
          periodStart: periodStart || null,
          projectIds: allSelected ? null : [...selectedIds],
          notes: notes || null,
        }),
      });
      if (outcome.skipped.length === 0) {
        toast.success(t("billRun.created", { count: outcome.created.length }));
        onFinished(outcome.created.length === 1 ? outcome.created[0]!.id : null);
        return;
      }
      setResult(outcome);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={result ? () => onFinished(null) : onClose}
      size="lg"
      title={t("billRun.title")}
      description={t("billRun.description")}
      headerActions={result ? (
        <Button onClick={() => onFinished(null)}>{t("billRun.done")}</Button>
      ) : (
        <>
          <Button variant="outline" onClick={onClose}>{t("billRun.cancel")}</Button>
          <Button disabled={busy || !periodEnd || selectedIds.size === 0} onClick={run}>
            {busy ? t("billRun.running") : t("billRun.submit", { count: selectedIds.size })}
          </Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-4">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {t("billRun.created", { count: result.created.length })}
          </p>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{t("billRun.skippedTitle")}</h3>
            <ul className="space-y-2">
              {result.skipped.map((entry) => (
                <li key={entry.projectId} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/20">
                  <p className="font-medium text-slate-900 dark:text-slate-100">{entry.projectName}</p>
                  <p className="text-amber-800 dark:text-amber-200">{entry.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bill-run-end">{t("billRun.cutoff")}</Label>
              <Input id="bill-run-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bill-run-start">{t("billRun.start")}</Label>
              <Input id="bill-run-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("billRun.projects")}</h3>
              <button
                type="button"
                className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(unbilled.map((row) => row.projectId)))}
              >
                {allSelected ? t("billRun.selectNone") : t("billRun.selectAll")}
              </button>
            </div>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {unbilled.map((row) => (
                <li key={row.projectId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-900">
                    <input type="checkbox" checked={selectedIds.has(row.projectId)} onChange={() => toggle(row.projectId)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{row.projectName}</span>
                      <span className="block truncate text-xs text-slate-500">{row.customerName ?? "—"} · {row.projectTypeName}</span>
                    </span>
                    <span className="text-right">
                      <span className="block text-sm font-semibold tabular-nums">{money(row.unbilledAmount)}</span>
                      <span className="block text-xs text-slate-500">{t("billRun.oldest", { date: row.oldestWorkDate })}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-run-notes">{t("billRun.notes")}</Label>
            <Textarea id="bill-run-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>
      )}
    </Drawer>
  );
}

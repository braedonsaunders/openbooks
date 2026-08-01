"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Clock3,
  FileText,
  Lock,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  EmptyState,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@openbooks/ui";
import { useMoney } from "../../../../components/money-provider";
import { HomeStatTile } from "../../../../components/module-home/client";
import type {
  PrebillDetail,
  PrebillLineRow,
  PrebillListRow,
  WipAnalytics,
} from "../../../../lib/wip-billing";

type ProjectOption = { id: string; name: string; customerName: string | null };

const STATUS_VARIANT = {
  draft: "secondary",
  review: "warning",
  approved: "success",
  converted: "success",
  void: "outline",
} as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

function DetailMetric({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <Card
      className={cn(
        tone === "danger" && "border-red-200 dark:border-red-900",
        tone === "warning" && "border-amber-200 dark:border-amber-900",
      )}
    >
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </p>
        <p
          className={cn(
            "mt-1 text-xl font-semibold tabular-nums text-slate-950 dark:text-slate-50",
            tone === "danger" && "text-red-700 dark:text-red-300",
            tone === "warning" && "text-amber-700 dark:text-amber-300",
          )}
        >
          {value}
        </p>
        {note ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {note}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function WipBillingWorkspace({
  prebills,
  projects,
  analytics,
  selected,
  canManage,
  canApprove,
  canCreateInvoice,
}: {
  prebills: PrebillListRow[];
  projects: ProjectOption[];
  analytics: WipAnalytics;
  selected: PrebillDetail | null;
  canManage: boolean;
  canApprove: boolean;
  canCreateInvoice: boolean;
}) {
  const router = useRouter();
  const { money } = useMoney();
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState(today());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [workflowAction, setWorkflowAction] = useState<
    "return" | "void" | null
  >(null);
  const [workflowReason, setWorkflowReason] = useState("");
  const agingTotal = useMemo(
    () =>
      ["current", "days1to30", "days31to60", "days61to90", "over90"].reduce(
        (total, key) =>
          total +
          Number(analytics.aging[key as keyof typeof analytics.aging] ?? 0),
        0,
      ),
    [analytics],
  );

  async function createWorksheet() {
    if (!projectId || !periodEnd) return;
    setBusy("create");
    try {
      const result = await requestJson("/api/wip-billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          periodStart: periodStart || null,
          periodEnd,
          notes: notes || null,
        }),
      });
      toast.success(
        `${result.worksheetNumber} created with ${result.sourceCount} source lines`,
      );
      setCreating(false);
      router.push(`/projects/wip-billing?prebill=${result.id}`);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function transition(
    action: "submit" | "return" | "approve" | "void",
    suppliedReason?: string,
  ) {
    if (!selected) return;
    const reason = suppliedReason?.trim();
    if ((action === "return" || action === "void") && !reason) return;
    setBusy(action);
    try {
      await requestJson(`/api/wip-billing/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      toast.success(
        action === "submit"
          ? "Sent for review"
          : action === "approve"
            ? "Prebill approved"
            : action === "return"
              ? "Returned to draft"
              : "Prebill voided",
      );
      setWorkflowAction(null);
      setWorkflowReason("");
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function convert() {
    if (!selected) return;
    setBusy("convert");
    try {
      const result = await requestJson(
        `/api/wip-billing/${selected.id}/convert`,
        { method: "POST" },
      );
      toast.success(`${result.documentNumber} created as a draft invoice`);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function closeSelected() {
    setWorkflowAction(null);
    setWorkflowReason("");
    router.push("/projects/wip-billing");
  }
  return (
    <div className="space-y-4">
      <section
        aria-label="WIP health"
        className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <HomeStatTile
          label="Available WIP"
          value={money(agingTotal)}
          sub="Eligible and not held"
          icon="wallet"
          accent="teal"
        />
        <HomeStatTile
          label="Over 90 days"
          value={money(Number(analytics.aging.over90))}
          sub={`${money(Number(analytics.aging.days61to90))} at 61–90 days`}
          icon="calendar-clock"
          accent="red"
          tone={Number(analytics.aging.over90) > 0 ? "negative" : "neutral"}
        />
        <HomeStatTile
          label="Realization"
          value={
            analytics.realization.percent == null
              ? "—"
              : `${(analytics.realization.percent * 100).toFixed(1)}%`
          }
          sub={`${money(Number(analytics.realization.billed))} billed`}
          icon="trending-up"
          accent="emerald"
        />
        <HomeStatTile
          label="Leakage"
          value={money(Number(analytics.leakage.total))}
          sub={`${money(Number(analytics.leakage.heldOver90))} held over 90 days`}
          icon="triangle-alert"
          accent={Number(analytics.leakage.total) > 0 ? "red" : "amber"}
          tone={Number(analytics.leakage.total) > 0 ? "negative" : "neutral"}
        />
      </section>

      <Card className="min-w-0 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col items-stretch justify-between gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center dark:border-slate-800">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Prebill worksheets
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Review eligible project work, billing adjustments, and approval
                status.
              </div>
            </div>
            {canManage ? (
              <Button
                disabled={projects.length === 0}
                onClick={() => setCreating(true)}
              >
                <Plus className="mr-2 size-4" />
                New prebill
              </Button>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            {prebills.length === 0 ? (
              <EmptyState
                className="m-6"
                icon={<FileText />}
                title={
                  projects.length === 0
                    ? "Create a project first"
                    : "No prebill worksheets yet"
                }
                description={
                  projects.length === 0
                    ? "WIP review starts from an active project with billable time or cost."
                    : "Create a worksheet to snapshot eligible unbilled project work through a cutoff date."
                }
                action={
                  canManage ? (
                    projects.length > 0 ? (
                      <Button onClick={() => setCreating(true)}>
                        <Plus className="mr-2 size-4" />
                        Create prebill
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <Link href="/projects">Go to projects</Link>
                      </Button>
                    )
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worksheet</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Proposed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prebills.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn(
                        "cursor-pointer",
                        selected?.id === row.id &&
                          "bg-teal-50/70 dark:bg-teal-950/20",
                      )}
                      onClick={() =>
                        router.push(`/projects/wip-billing?prebill=${row.id}`)
                      }
                    >
                      <TableCell>
                        <p className="font-medium">{row.worksheetNumber}</p>
                        <p className="text-xs text-slate-500">
                          Through {row.periodEnd}
                        </p>
                      </TableCell>
                      <TableCell>
                        <p>{row.projectName}</p>
                        <p className="text-xs text-slate-500">
                          {row.customerName ?? "No customer"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(Number(row.proposedBillAmount))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        size="md"
        title="New prebill worksheet"
        description="Snapshot eligible unbilled work through a cutoff date."
        headerActions={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={!projectId || !periodEnd || busy === "create"}
              onClick={createWorksheet}
            >
              {busy === "create" ? "Creating…" : "Create prebill"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="wip-project">Project</Label>
            <Select
              id="wip-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                  {project.customerName ? ` · ${project.customerName}` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wip-start">Start (optional)</Label>
            <Input
              id="wip-start"
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wip-end">Cutoff</Label>
            <Input
              id="wip-end"
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="wip-notes">Review notes</Label>
            <Textarea
              id="wip-notes"
              rows={4}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Scope, billing instructions, or reviewer context"
            />
          </div>
        </div>
      </Drawer>

      {selected ? (
        <Drawer
          open
          onClose={closeSelected}
          size="2xl"
          title={
            <span className="flex items-center gap-2.5">
              <span>{selected.worksheetNumber}</span>
              <Badge variant={STATUS_VARIANT[selected.status]}>
                {selected.status}
              </Badge>
            </span>
          }
          description={`${selected.projectName} · through ${selected.periodEnd}`}
          headerActions={
            <>
              {selected.status === "draft" && canManage ? (
                <Button
                  onClick={() => transition("submit")}
                  disabled={Boolean(busy)}
                >
                  <Send className="mr-2 size-4" />
                  Send for review
                </Button>
              ) : null}
              {selected.status === "review" && canManage ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setWorkflowAction("return");
                    setWorkflowReason("");
                  }}
                  disabled={Boolean(busy)}
                >
                  <RotateCcw className="mr-2 size-4" />
                  Return
                </Button>
              ) : null}
              {selected.status === "review" && canApprove ? (
                <Button
                  onClick={() => transition("approve")}
                  disabled={Boolean(busy)}
                >
                  <ShieldCheck className="mr-2 size-4" />
                  Approve
                </Button>
              ) : null}
              {selected.status === "approved" && canCreateInvoice ? (
                <Button onClick={convert} disabled={Boolean(busy)}>
                  <FileText className="mr-2 size-4" />
                  {busy === "convert" ? "Converting…" : "Create invoice"}
                </Button>
              ) : null}
              {["draft", "review", "approved"].includes(selected.status) &&
              canManage ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setWorkflowAction("void");
                    setWorkflowReason("");
                  }}
                  disabled={Boolean(busy)}
                >
                  <X className="mr-2 size-4" />
                  Void
                </Button>
              ) : null}
              {selected.invoiceDocumentId ? (
                <Button asChild variant="outline">
                  <Link
                    href={`/ar/invoices?invoice=${selected.invoiceDocumentId}`}
                  >
                    Open {selected.invoiceNumber}
                  </Link>
                </Button>
              ) : null}
            </>
          }
        >
          <div className="space-y-5">
            {workflowAction ? (
              <section
                aria-labelledby="workflow-reason-title"
                className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/40"
              >
                <h3
                  id="workflow-reason-title"
                  className="font-medium text-slate-900 dark:text-slate-100"
                >
                  {workflowAction === "return"
                    ? "Return worksheet to draft"
                    : "Void worksheet"}
                </h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {workflowAction === "return"
                    ? "Explain what the preparer needs to correct. This becomes part of the review trail."
                    : "Explain why this worksheet must not proceed. The source WIP remains available for a future worksheet."}
                </p>
                <div className="mt-3 space-y-1.5">
                  <Label htmlFor="workflow-reason">Reason</Label>
                  <Textarea
                    id="workflow-reason"
                    autoFocus
                    value={workflowReason}
                    onChange={(event) => setWorkflowReason(event.target.value)}
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant={
                      workflowAction === "void" ? "destructive" : "default"
                    }
                    disabled={!workflowReason.trim() || Boolean(busy)}
                    onClick={() => transition(workflowAction, workflowReason)}
                  >
                    {busy === workflowAction
                      ? "Saving…"
                      : workflowAction === "return"
                        ? "Return to draft"
                        : "Void worksheet"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setWorkflowAction(null);
                      setWorkflowReason("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-4">
              <DetailMetric
                label="Original"
                value={money(Number(selected.originalBillAmount))}
              />
              <DetailMetric
                label="Proposed"
                value={money(Number(selected.proposedBillAmount))}
              />
              <DetailMetric
                label="Adjustment"
                value={money(Number(selected.adjustmentAmount))}
                tone={
                  Number(selected.adjustmentAmount) < 0
                    ? "danger"
                    : Number(selected.adjustmentAmount) > 0
                      ? "warning"
                      : "default"
                }
              />
              <DetailMetric
                label="Cost"
                value={money(Number(selected.costAmount))}
              />
            </div>
            {selected.status === "approved" ? (
              <Alert>
                <Lock className="size-4" />
                <AlertDescription>
                  This approval snapshot is locked. Convert it as approved, or
                  void it and prepare a new worksheet.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Original</TableHead>
                    <TableHead className="min-w-72">
                      Proposed / support
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.lines.map((line) => (
                    <PrebillLine
                      key={line.id}
                      line={line}
                      prebill={selected}
                      editable={selected.status === "draft" && canManage}
                      onChanged={() => router.refresh()}
                      money={money}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Review trail
              </h3>
              <ol className="space-y-2">
                {selected.events.map((event) => (
                  <li key={event.id} className="flex gap-3 text-sm">
                    <Clock3 className="mt-0.5 size-4 shrink-0 text-slate-400" />
                    <div>
                      <span className="font-medium capitalize">
                        {event.eventType.replaceAll("_", " ")}
                      </span>
                      <span className="text-slate-500">
                        {" "}
                        · {event.actorName ?? "System"} ·{" "}
                        {new Date(event.occurredAt).toLocaleString()}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

function PrebillLine({
  line,
  prebill,
  editable,
  onChanged,
  money,
}: {
  line: PrebillLineRow;
  prebill: PrebillDetail;
  editable: boolean;
  onChanged: () => void;
  money: (value: number) => string;
}) {
  const [amount, setAmount] = useState(line.proposedBillAmount);
  const [reason, setReason] = useState(line.adjustmentReason ?? "");
  const [evidence, setEvidence] = useState(line.adjustmentEvidence.join(", "));
  const [saving, setSaving] = useState(false);
  const [holdForm, setHoldForm] = useState<"hold" | "release" | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [holdEvidence, setHoldEvidence] = useState("");
  const changed = Number(amount) !== Number(line.originalBillAmount);

  async function save() {
    setSaving(true);
    try {
      await requestJson(`/api/wip-billing/${prebill.id}/lines/${line.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposedBillAmount: amount,
          adjustmentReason: reason,
          adjustmentEvidence: evidence
            .split(/[,\n]/)
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      toast.success("Billing amount saved");
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function hold() {
    if (!holdReason.trim()) return;
    setSaving(true);
    try {
      await requestJson(`/api/wip-billing/${prebill.id}/lines/${line.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "hold",
          reason: holdReason.trim(),
          evidence: holdEvidence
            .split(/[,\n]/)
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      toast.success("Billing hold applied");
      setHoldForm(null);
      setHoldReason("");
      setHoldEvidence("");
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function release() {
    if (!line.holdId) return;
    if (!holdReason.trim()) return;
    setSaving(true);
    try {
      await requestJson(`/api/wip-billing/holds/${line.holdId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: holdReason.trim() }),
      });
      toast.success("Billing hold released");
      setHoldForm(null);
      setHoldReason("");
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableRow
      className={
        line.disposition === "hold"
          ? "bg-amber-50/60 dark:bg-amber-950/10"
          : undefined
      }
    >
      <TableCell>
        <Badge variant={line.disposition === "hold" ? "warning" : "outline"}>
          {line.disposition === "hold"
            ? "Held"
            : line.sourceType === "time_entry"
              ? "Time"
              : "Cost"}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">{line.sourceDate}</TableCell>
      <TableCell>
        <p className="max-w-80 truncate">{line.description ?? "—"}</p>
        {line.holdReason ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {line.holdReason}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {money(Number(line.costAmount))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {money(Number(line.originalBillAmount))}
      </TableCell>
      <TableCell>
        {editable && line.disposition === "bill" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                aria-label="Proposed billing amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="max-w-36 text-right tabular-nums"
              />
              {changed ? (
                Number(amount) > Number(line.originalBillAmount) ? (
                  <ArrowUpRight className="mt-2 size-4 text-amber-600" />
                ) : (
                  <ArrowDownRight className="mt-2 size-4 text-red-600" />
                )
              ) : (
                <Check className="mt-2 size-4 text-emerald-600" />
              )}
            </div>
            {changed ? (
              <>
                <Input
                  aria-label="Adjustment reason"
                  placeholder="Adjustment reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Input
                  aria-label="Adjustment evidence"
                  placeholder="Evidence references, comma separated"
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setHoldForm("hold");
                  setHoldReason("");
                  setHoldEvidence("");
                }}
                disabled={saving}
              >
                <AlertTriangle className="mr-1.5 size-3.5" />
                Hold
              </Button>
            </div>
            {holdForm === "hold" ? (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <Label htmlFor={`hold-reason-${line.id}`}>Hold reason</Label>
                <Textarea
                  id={`hold-reason-${line.id}`}
                  autoFocus
                  value={holdReason}
                  onChange={(event) => setHoldReason(event.target.value)}
                />
                <Label htmlFor={`hold-evidence-${line.id}`}>
                  Evidence references
                </Label>
                <Input
                  id={`hold-evidence-${line.id}`}
                  value={holdEvidence}
                  onChange={(event) => setHoldEvidence(event.target.value)}
                  placeholder="File, URL, or note; comma separated"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!holdReason.trim() || saving}
                    onClick={hold}
                  >
                    Apply hold
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setHoldForm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : line.disposition === "hold" && editable ? (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setHoldForm("release");
                setHoldReason("");
              }}
              disabled={saving}
            >
              Release hold
            </Button>
            {holdForm === "release" ? (
              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/30">
                <Label htmlFor={`release-reason-${line.id}`}>
                  Release reason
                </Label>
                <Textarea
                  id={`release-reason-${line.id}`}
                  autoFocus
                  value={holdReason}
                  onChange={(event) => setHoldReason(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!holdReason.trim() || saving}
                    onClick={release}
                  >
                    Release
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setHoldForm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-right">
            <p className="font-medium tabular-nums">
              {money(Number(line.proposedBillAmount))}
            </p>
            {line.adjustmentReason ? (
              <p className="mt-1 text-xs text-slate-500">
                {line.adjustmentReason}
              </p>
            ) : null}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

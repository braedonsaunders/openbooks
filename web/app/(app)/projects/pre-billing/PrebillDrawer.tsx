"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  Inbox,
  Lock,
  MessageSquareWarning,
  RotateCcw,
  Send,
  UserCheck,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@openbooks/ui";
import { DrawerTabStrip } from "../../../../components/drawer-tab-strip";
import { useMoney } from "../../../../components/money-provider";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { decimalCmp, decimalSum } from "../../../../lib/statement-format";
import { useViewerFormat } from "../../../../lib/viewer-format";
import { prebillStage } from "../../../../lib/pre-billing-stages";
import type { PrebillDetail, PrebillLineRow } from "../../../../lib/pre-billing";
import { requestJson, STAGE_TONE } from "./PreBillingWorkspace";

type Panel = "reopen" | "void" | "send" | "deliver" | null;

/**
 * One billing package, edited side by side: the invoice exactly as the
 * customer will see it on the left, and the source work behind it — with
 * write-ups, write-downs, holds and the customer's line notes — on the right.
 */
export function PrebillDrawer({
  prebill,
  canManage,
  canCreateInvoice,
  customerPortalEnabled,
  onClose,
}: {
  prebill: PrebillDetail;
  canManage: boolean;
  canCreateInvoice: boolean;
  customerPortalEnabled: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("projects.preBilling");
  const router = useRouter();
  const { money } = useMoney();
  const { dateTime } = useViewerFormat();
  const stage = prebillStage(prebill);
  const [tab, setTab] = useState<"work" | "activity">("work");
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const billLines = prebill.lines.filter((line) => line.disposition === "bill");
  const reviewBlocksInvoice = prebill.customerReviewRequired && prebill.customerDecision !== "accepted";
  const editable = prebill.status === "draft" && canManage;

  function openPanel(next: Panel) {
    setPanel(next);
    setReason("");
    setRecipient("");
    setMessage("");
  }

  async function act(action: string, body: Record<string, unknown>, success: (result: Record<string, unknown>) => string) {
    setBusy(action);
    try {
      const result = await requestJson(`/api/pre-billing/${prebill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const note = success(result);
      if (action === "send_to_customer" && result.emailed === false) toast.warning(note);
      else toast.success(note);
      setPanel(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function convert() {
    setBusy("convert");
    try {
      const result = await requestJson<{ documentNumber: string }>(`/api/pre-billing/${prebill.id}/convert`, { method: "POST" });
      toast.success(t("toasts.converted", { documentNumber: result.documentNumber }));
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const headerActions = (
    <>
      {prebill.status === "draft" && canManage ? (
        <Button onClick={() => act("submit", {}, (result) => result.status === "approved" ? t("toasts.approved") : t("toasts.submitted"))} disabled={Boolean(busy)}>
          <Send className="mr-2 size-4" />
          {busy === "submit" ? t("detail.submitting") : t("detail.submit")}
        </Button>
      ) : null}
      {prebill.status === "review" ? (
        <Button asChild variant="outline">
          <Link href="/inbox">
            <Inbox className="mr-2 size-4" />
            {t("detail.openInbox")}
          </Link>
        </Button>
      ) : null}
      {prebill.status === "approved" && customerPortalEnabled && canManage && prebill.customerDecision !== "accepted" ? (
        <Button variant={reviewBlocksInvoice ? "default" : "outline"} onClick={() => openPanel("send")} disabled={Boolean(busy)}>
          <UserCheck className="mr-2 size-4" />
          {t("detail.sendToCustomer")}
        </Button>
      ) : null}
      {prebill.status === "approved" && canCreateInvoice ? (
        <Button onClick={convert} disabled={Boolean(busy) || reviewBlocksInvoice} title={reviewBlocksInvoice ? t("detail.reviewRequiredHint") : undefined}>
          <FileText className="mr-2 size-4" />
          {busy === "convert" ? t("detail.converting") : t("detail.createInvoice")}
        </Button>
      ) : null}
      {prebill.status === "converted" && canCreateInvoice && prebill.invoiceStatus === "posted" ? (
        <Button variant={stage === "invoiced" ? "default" : "outline"} onClick={() => openPanel("deliver")} disabled={Boolean(busy)}>
          <Send className="mr-2 size-4" />
          {prebill.deliveredAt ? t("detail.resendInvoice") : t("detail.sendInvoice")}
        </Button>
      ) : null}
      {prebill.invoiceDocumentId ? (
        <Button asChild variant="outline">
          <Link href={`/ar/invoices?invoice=${prebill.invoiceDocumentId}`}>
            {t("detail.openInvoice", { invoiceNumber: prebill.invoiceNumber ?? "" })}
          </Link>
        </Button>
      ) : null}
      {["approved", "customer_review"].includes(prebill.status) && canManage ? (
        <Button variant="outline" onClick={() => openPanel("reopen")} disabled={Boolean(busy)}>
          <RotateCcw className="mr-2 size-4" />
          {t("detail.reopen")}
        </Button>
      ) : null}
      {["draft", "approved", "customer_review"].includes(prebill.status) && canManage ? (
        <Button variant="outline" onClick={() => openPanel("void")} disabled={Boolean(busy)}>
          <X className="mr-2 size-4" />
          {t("detail.void")}
        </Button>
      ) : null}
    </>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      size="full"
      title={
        <span className="flex items-center gap-2.5">
          <span>{prebill.worksheetNumber}</span>
          <Badge variant={STAGE_TONE[stage]}>{t(`stages.${stage}`)}</Badge>
        </span>
      }
      description={t("detail.description", { projectName: prebill.projectName, customerName: prebill.customerName ?? "—" })}
      headerActions={headerActions}
    >
      <div className="space-y-4">
        <StatusNotice prebill={prebill} stage={stage} dateTime={(value) => dateTime(new Date(value))} />

        {panel ? (
          <ActionPanel
            panel={panel}
            reason={reason}
            setReason={setReason}
            recipient={recipient}
            setRecipient={setRecipient}
            message={message}
            setMessage={setMessage}
            busy={busy}
            onCancel={() => setPanel(null)}
            onSubmit={() => {
              if (panel === "reopen") void act("reopen", { reason }, () => t("toasts.reopened"));
              if (panel === "void") void act("void", { reason }, () => t("toasts.voided"));
              if (panel === "send") {
                void act("send_to_customer", { to: recipient || null, message: message || null }, (result) =>
                  result.emailed === false
                    ? t("toasts.sentNoEmail", { error: String(result.emailError ?? "") })
                    : t("toasts.sentToCustomer", { to: String(result.recipient ?? "") }));
              }
              if (panel === "deliver") {
                void act("deliver", { to: recipient || null, message: message || null }, (result) =>
                  result.backupAttached ? t("toasts.deliveredWithBackup", { to: String(result.to ?? "") }) : t("toasts.delivered", { to: String(result.to ?? "") }));
              }
            }}
          />
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <InvoicePreview prebill={prebill} lines={billLines} money={money} />

          <section className="min-w-0">
            <DrawerTabStrip
              ariaLabel={t("tabs.aria")}
              activeKey={tab}
              onSelect={setTab}
              tabs={[
                { key: "work", label: t("tabs.work"), count: prebill.lines.length },
                { key: "activity", label: t("tabs.activity"), count: prebill.events.length },
              ]}
            />
            <div className="mt-3">
              {tab === "work" ? (
                <>
                  {prebill.status !== "draft" && prebill.status !== "void" ? (
                    <Alert className="mb-3">
                      <Lock className="size-4" />
                      <AlertDescription>{t("lockedAlert")}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("linesTable.source")}</TableHead>
                          <TableHead>{t("linesTable.date")}</TableHead>
                          <TableHead>{t("linesTable.description")}</TableHead>
                          <TableHead className="text-right">{t("linesTable.cost")}</TableHead>
                          <TableHead className="text-right">{t("linesTable.original")}</TableHead>
                          <TableHead className="min-w-72">{t("linesTable.proposedSupport")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {prebill.lines.map((line) => (
                          <PrebillLine
                            key={line.id}
                            line={line}
                            prebillId={prebill.id}
                            editable={editable}
                            onChanged={() => router.refresh()}
                            money={money}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              ) : (
                <ol className="space-y-2">
                  {prebill.events.map((event) => (
                    <li key={event.id} className="flex gap-3 text-sm">
                      <Clock3 className="mt-0.5 size-4 shrink-0 text-slate-400" />
                      <div>
                        <span className="font-medium">
                          {t.has(`events.${event.eventType}`) ? t(`events.${event.eventType}`) : event.eventType.replaceAll("_", " ")}
                        </span>
                        <span className="text-slate-500">
                          {" "}· {event.actorName ?? (event.eventType.startsWith("customer_") ? t("trail.customer") : t("trail.system"))} ·{" "}
                          {dateTime(new Date(event.occurredAt))}
                        </span>
                        {eventReason(event.details) ? (
                          <p className="text-xs text-slate-500">{eventReason(event.details)}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>
      </div>
    </Drawer>
  );
}

function eventReason(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

function StatusNotice({
  prebill,
  stage,
  dateTime,
}: {
  prebill: PrebillDetail;
  stage: ReturnType<typeof prebillStage>;
  dateTime: (value: string) => string;
}) {
  const t = useTranslations("projects.preBilling");
  if (prebill.status === "draft" && prebill.customerDecision === "disputed") {
    return (
      <Alert variant="destructive">
        <MessageSquareWarning className="size-4" />
        <AlertDescription>
          <p className="font-medium">{t("notice.disputed", { count: prebill.disputedLineCount })}</p>
          {prebill.customerDecisionNote ? <p className="mt-1">“{prebill.customerDecisionNote}”</p> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (prebill.status === "review") {
    return (
      <Alert>
        <Inbox className="size-4" />
        <AlertDescription>{t("notice.inApproval")}</AlertDescription>
      </Alert>
    );
  }
  if (prebill.status === "customer_review") {
    return (
      <Alert>
        <UserCheck className="size-4" />
        <AlertDescription>
          {prebill.customerViewedAt
            ? t("notice.withCustomerViewed", { sent: dateTime(prebill.customerReviewSentAt!), viewed: dateTime(prebill.customerViewedAt) })
            : t("notice.withCustomer", { sent: dateTime(prebill.customerReviewSentAt!) })}
        </AlertDescription>
      </Alert>
    );
  }
  if (prebill.status === "approved" && prebill.customerReviewRequired && prebill.customerDecision !== "accepted") {
    return (
      <Alert>
        <AlertTriangle className="size-4" />
        <AlertDescription>{t("detail.reviewRequiredHint")}</AlertDescription>
      </Alert>
    );
  }
  if (stage === "invoiced" && prebill.invoiceStatus !== "posted") {
    return (
      <Alert>
        <FileText className="size-4" />
        <AlertDescription>{t("notice.postInvoice", { invoiceNumber: prebill.invoiceNumber ?? "" })}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function InvoicePreview({ prebill, lines, money }: { prebill: PrebillDetail; lines: PrebillLineRow[]; money: (value: string) => string }) {
  const t = useTranslations("projects.preBilling");
  const subtotal = decimalSum(lines.map((line) => line.proposedBillAmount));
  const margin = decimalSum([subtotal, `-${prebill.costAmount}`]);
  return (
    <section aria-label={t("preview.title")} className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("preview.title")}</p>
            <p className="mt-1 text-sm text-slate-500">{t("preview.billTo")}</p>
            <p className="font-semibold text-slate-900 dark:text-slate-100">{prebill.customerName ?? "—"}</p>
          </div>
          <div className="text-right text-sm">
            <p className="text-slate-500">{t("preview.project")}</p>
            <p className="font-medium text-slate-900 dark:text-slate-100">{prebill.projectName}</p>
            <p className="mt-1 text-slate-500">
              {prebill.periodStart
                ? t("card.period", { start: prebill.periodStart, end: prebill.periodEnd })
                : t("card.through", { date: prebill.periodEnd })}
            </p>
            {prebill.customerPoNumber ? (
              <p className="mt-1 text-slate-500">{t("preview.po", { po: prebill.customerPoNumber })}</p>
            ) : null}
          </div>
        </div>
        <ul className="mt-4 divide-y divide-slate-100 border-y border-slate-100 text-sm dark:divide-slate-800 dark:border-slate-800">
          {lines.length === 0 ? (
            <li className="py-3 text-slate-500">{t("preview.empty")}</li>
          ) : lines.map((line) => (
            <li key={line.id} className={cn("flex items-start justify-between gap-3 py-2", line.customerDisputeNote && "bg-red-50/60 dark:bg-red-950/10")}>
              <span className="min-w-0">
                <span className="block truncate text-slate-900 dark:text-slate-100">{line.description ?? "—"}</span>
                <span className="block text-xs text-slate-500">
                  {line.sourceDate} · {line.quantity.replace(/\.?0+$/, "")}{line.unit ? ` ${line.unit}` : ""}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{money(line.proposedBillAmount)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t("preview.subtotal")}</span>
          <span className="text-xl font-semibold tabular-nums text-slate-950 dark:text-slate-50">{money(subtotal)}</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">{t("preview.taxNote")}</p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <PreviewMetric label={t("metrics.original")} value={money(prebill.originalBillAmount)} />
        <PreviewMetric
          label={t("metrics.adjustment")}
          value={money(prebill.adjustmentAmount)}
          tone={decimalCmp(prebill.adjustmentAmount, "0") < 0 ? "danger" : decimalCmp(prebill.adjustmentAmount, "0") > 0 ? "warning" : "default"}
        />
        <PreviewMetric label={t("metrics.cost")} value={money(prebill.costAmount)} />
        <PreviewMetric label={t("metrics.margin")} value={money(margin)} tone={decimalCmp(margin, "0") < 0 ? "danger" : "default"} />
      </dl>

      {prebill.customerDecision === "accepted" ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950/20">
          <p className="flex items-center gap-1.5 font-medium text-green-800 dark:text-green-200">
            <CheckCircle2 className="size-4" />
            {t("customer.accepted", { name: prebill.customerSignerName ?? "" })}
          </p>
          {prebill.customerDecisionNote ? <p className="mt-1 text-green-900 dark:text-green-100">“{prebill.customerDecisionNote}”</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function PreviewMetric({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "warning" | "danger" }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cn(
        "font-semibold tabular-nums text-slate-900 dark:text-slate-100",
        tone === "danger" && "text-red-700 dark:text-red-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300",
      )}>
        {value}
      </dd>
    </div>
  );
}

function ActionPanel({
  panel,
  reason,
  setReason,
  recipient,
  setRecipient,
  message,
  setMessage,
  busy,
  onCancel,
  onSubmit,
}: {
  panel: Exclude<Panel, null>;
  reason: string;
  setReason: (value: string) => void;
  recipient: string;
  setRecipient: (value: string) => void;
  message: string;
  setMessage: (value: string) => void;
  busy: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("projects.preBilling");
  const needsReason = panel === "reopen" || panel === "void";
  return (
    <section
      aria-labelledby="prebill-panel-title"
      className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/40"
    >
      <h3 id="prebill-panel-title" className="font-medium text-slate-900 dark:text-slate-100">{t(`panels.${panel}.title`)}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t(`panels.${panel}.description`)}</p>
      {needsReason ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="prebill-reason">{t("panels.reason")}</Label>
          <Textarea id="prebill-reason" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="prebill-recipient">{t("panels.recipient")}</Label>
            <Input id="prebill-recipient" type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} />
            <p className="text-xs text-slate-500">{t("panels.recipientHelp")}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="prebill-message">{t("panels.message")}</Label>
            <Textarea id="prebill-message" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
          </div>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          variant={panel === "void" ? "destructive" : "default"}
          disabled={(needsReason && !reason.trim()) || Boolean(busy)}
          onClick={onSubmit}
        >
          {busy ? t("panels.working") : t(`panels.${panel}.submit`)}
        </Button>
        <Button variant="outline" onClick={onCancel}>{t("panels.cancel")}</Button>
      </div>
    </section>
  );
}

function PrebillLine({
  line,
  prebillId,
  editable,
  onChanged,
  money,
}: {
  line: PrebillLineRow;
  prebillId: string;
  editable: boolean;
  onChanged: () => void;
  money: (value: string) => string;
}) {
  const t = useTranslations("projects.preBilling");
  const [amount, setAmount] = useState(line.proposedBillAmount);
  const [reason, setReason] = useState(line.adjustmentReason ?? "");
  const [evidence, setEvidence] = useState(line.adjustmentEvidence.join(", "));
  const [saving, setSaving] = useState(false);
  const [holdForm, setHoldForm] = useState<"hold" | "release" | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [holdEvidence, setHoldEvidence] = useState("");
  const exactAmount = canonicalDecimal(amount, 4);
  const amountComparison = exactAmount === null ? null : decimalCmp(exactAmount, line.originalBillAmount);
  const changed = amountComparison !== 0;
  const dirty = exactAmount === null || decimalCmp(exactAmount, line.proposedBillAmount) !== 0
    || reason !== (line.adjustmentReason ?? "") || evidence !== line.adjustmentEvidence.join(", ");
  const splitList = (value: string) => value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);

  async function patch(url: string, body: Record<string, unknown>, success: string) {
    setSaving(true);
    try {
      await requestJson(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success(success);
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

  return (
    <TableRow
      className={cn(
        line.disposition === "hold" && "bg-amber-50/60 dark:bg-amber-950/10",
        line.customerDisputeNote && "bg-red-50/60 dark:bg-red-950/10",
      )}
    >
      <TableCell>
        <Badge variant={line.disposition === "hold" ? "warning" : "outline"}>
          {line.disposition === "hold" ? t("line.held") : line.sourceType === "time_entry" ? t("line.time") : t("line.cost")}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">{line.sourceDate}</TableCell>
      <TableCell>
        <p className="max-w-80 truncate">{line.description ?? "—"}</p>
        {line.holdReason ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{line.holdReason}</p> : null}
        {line.customerDisputeNote ? (
          <p className="mt-1 flex items-start gap-1 text-xs text-red-700 dark:text-red-300">
            <MessageSquareWarning className="mt-0.5 size-3 shrink-0" />
            {t("line.customerNote", { note: line.customerDisputeNote })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(line.costAmount)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(line.originalBillAmount)}</TableCell>
      <TableCell>
        {editable && line.disposition === "bill" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                aria-label={t("line.amountAria")}
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="max-w-36 text-right tabular-nums"
              />
              {changed ? (
                amountComparison !== null && amountComparison > 0
                  ? <ArrowUpRight className="mt-2 size-4 text-amber-600" />
                  : <ArrowDownRight className="mt-2 size-4 text-red-600" />
              ) : (
                <Check className="mt-2 size-4 text-emerald-600" />
              )}
            </div>
            {changed ? (
              <>
                <Input aria-label={t("line.reasonAria")} placeholder={t("line.reasonAria")} value={reason} onChange={(event) => setReason(event.target.value)} />
                <Input aria-label={t("line.evidencePlaceholder")} placeholder={t("line.evidencePlaceholder")} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
              </>
            ) : null}
            <div className="flex gap-2">
              {dirty ? (
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => patch(`/api/pre-billing/${prebillId}/lines/${line.id}`, {
                    proposedBillAmount: amount,
                    adjustmentReason: reason,
                    adjustmentEvidence: splitList(evidence),
                    expectedUpdatedAt: line.updatedAt,
                  }, t("lineToasts.saved"))}
                >
                  {saving ? t("line.saving") : t("line.save")}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={saving} onClick={() => { setHoldForm("hold"); setHoldReason(""); setHoldEvidence(""); }}>
                <AlertTriangle className="mr-1.5 size-3.5" />
                {t("line.hold")}
              </Button>
            </div>
            {holdForm === "hold" ? (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <Label htmlFor={`hold-reason-${line.id}`}>{t("line.holdReason")}</Label>
                <Textarea id={`hold-reason-${line.id}`} autoFocus value={holdReason} onChange={(event) => setHoldReason(event.target.value)} />
                <Label htmlFor={`hold-evidence-${line.id}`}>{t("line.evidenceReferences")}</Label>
                <Input id={`hold-evidence-${line.id}`} value={holdEvidence} onChange={(event) => setHoldEvidence(event.target.value)} placeholder={t("line.evidencePlaceholder")} />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!holdReason.trim() || saving}
                    onClick={() => patch(`/api/pre-billing/${prebillId}/lines/${line.id}`, {
                      action: "hold",
                      reason: holdReason.trim(),
                      evidence: splitList(holdEvidence),
                    }, t("lineToasts.holdApplied"))}
                  >
                    {t("line.applyHold")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setHoldForm(null)}>{t("panels.cancel")}</Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : line.disposition === "hold" && editable && line.holdId ? (
          <div className="space-y-2">
            <Button size="sm" variant="outline" disabled={saving} onClick={() => { setHoldForm("release"); setHoldReason(""); }}>
              {t("line.releaseHold")}
            </Button>
            {holdForm === "release" ? (
              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/30">
                <Label htmlFor={`release-reason-${line.id}`}>{t("line.releaseReason")}</Label>
                <Textarea id={`release-reason-${line.id}`} autoFocus value={holdReason} onChange={(event) => setHoldReason(event.target.value)} />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!holdReason.trim() || saving}
                    onClick={() => patch(`/api/pre-billing/holds/${line.holdId}`, { reason: holdReason.trim() }, t("lineToasts.holdReleased"))}
                  >
                    {t("line.release")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setHoldForm(null)}>{t("panels.cancel")}</Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-right">
            <p className="font-medium tabular-nums">{money(line.proposedBillAmount)}</p>
            {line.adjustmentReason ? <p className="mt-1 text-xs text-slate-500">{line.adjustmentReason}</p> : null}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

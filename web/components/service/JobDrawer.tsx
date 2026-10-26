"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Button,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import type { ServiceJobDetail } from "@openbooks/engine/service/reads";
import { DrawerTabStrip } from "../drawer-tab-strip";
import { promptDialog } from "../../lib/prompt";
import { postJson, refusalText, serviceRequest } from "./api";
import {
  Field,
  PriorityBadge,
  RecordStatusBadge,
  Refusal,
  Section,
  plainDecimal,
  useServiceFormat,
} from "./format";
import { VisitList, VisitPlanForm } from "./visit-list";

type Refused = { message: string; remedy: string | null } | null;
type Tab = "overview" | "visits" | "billing";
const INVOICE_STATUSES = new Set(["draft", "pending_approval", "approved", "posted", "voided"]);

type InvoicePreview = {
  lines: { description: string | null; quantity: string; unitPrice: string; amount: string }[];
  total: string;
  currency: string;
};
type DepositCandidate = {
  paymentDocumentId: string;
  documentNumber: string | null;
  postingDate: string;
  open: string;
  currency: string;
};

/** A service job: its scope, its visits and how it bills. */
export function ServiceJobBody({
  detail,
  reload,
  onOpenVisit,
}: {
  detail: ServiceJobDetail;
  reload: () => void;
  onOpenVisit: (visitId: string) => void;
}) {
  const t = useTranslations("service.job");
  const ts = useTranslations("service");
  const f = useServiceFormat();
  const { job } = detail;
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefused] = useState<Refused>(null);
  const [addingVisit, setAddingVisit] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setRefused(null);
    try {
      await action();
      reload();
    } catch (error) {
      setRefused(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function lifecycle(action: "complete" | "reopen" | "cancel") {
    let reason: string | undefined;
    if (action !== "complete") {
      const answer = await promptDialog({
        title: t(`${action}.title`),
        label: t(`${action}.reason`),
        multiline: true,
        confirmLabel: t(`${action}.confirm`),
      });
      if (!answer) return;
      reason = answer;
    }
    await run(() =>
      postJson(
        `/api/service/jobs/${job.id}/lifecycle`,
        { action, expectedRevision: job.revision, ...(reason ? { reason } : {}) },
        t("actionFailed"),
      ),
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <RecordStatusBadge status={job.status} family="job" />
        <PriorityBadge priority={job.priority} />
        <span className="text-xs text-slate-500">{ts(`billingMode.${job.billingMode}`)}</span>
        {detail.canManage ? (
          <div className="ml-auto flex gap-1.5">
            {job.status === "open" ? (
              <Button size="sm" disabled={busy} onClick={() => void lifecycle("complete")}>
                {t("complete.action")}
              </Button>
            ) : null}
            {job.status === "completed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void lifecycle("reopen")}
              >
                {t("reopen.action")}
              </Button>
            ) : null}
            {job.status === "open" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void lifecycle("cancel")}
              >
                {t("cancel.action")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Refusal refusal={refusal} />
      <DrawerTabStrip<Tab>
        ariaLabel={t("tabs.label")}
        activeKey={tab}
        onSelect={setTab}
        tabs={[
          { key: "overview", label: t("tabs.overview") },
          { key: "visits", label: t("tabs.visits"), count: detail.visits.length },
          {
            key: "billing",
            label: t("tabs.billing"),
            count: detail.billings.filter((billing) => !billing.releasedAt).length,
          },
        ]}
      />

      {tab === "overview" ? (
        <div className="space-y-5">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label={t("customer")}>{job.customerName}</Field>
            <Field label={t("address")}>{job.address ?? "—"}</Field>
            <Field label={t("contact")}>
              {[job.contactName, job.contactPhone, job.contactEmail].filter(Boolean).join(" · ") ||
                "—"}
            </Field>
            <Field label={t("duration")}>{f.minutes(job.estimatedMinutes)}</Field>
            <Field label={t("responseDue")}>{f.instant(job.slaDueAt)}</Field>
            <Field label={t("source")}>
              {job.requestNumber ? (
                <Link
                  className="text-teal-700 hover:underline dark:text-teal-300"
                  href={`/service/requests?request=${job.requestId}`}
                >
                  {job.requestNumber}
                </Link>
              ) : null}
              {job.quoteNumber ? (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    className="text-teal-700 hover:underline dark:text-teal-300"
                    href={`/estimates?estimate=${job.quoteDocumentId}`}
                  >
                    {job.quoteNumber}
                  </Link>
                </>
              ) : null}
              {job.agreementNumber ? (
                <Link
                  className="text-teal-700 hover:underline dark:text-teal-300"
                  href={`/service/agreements?agreement=${job.agreementId}`}
                >
                  {job.agreementNumber}
                </Link>
              ) : null}
              {!job.requestNumber && !job.quoteNumber && !job.agreementNumber ? t("direct") : null}
            </Field>
            {job.laborItemName ? (
              <Field label={t("labor")}>
                {job.laborItemName}
                {job.laborUnitPrice ? ` · ${f.money(job.laborUnitPrice, job.currency)}` : ""}
              </Field>
            ) : null}
            {job.closeReason ? <Field label={t("closeReason")}>{job.closeReason}</Field> : null}
          </dl>
          {job.description ? (
            <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
              {job.description}
            </p>
          ) : null}
          <Section title={t("scope")}>
            {detail.lines.length === 0 ? (
              <p className="text-sm text-slate-500">{t("noScope")}</p>
            ) : (
              <Table className="text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("item")}</TableHead>
                    <TableHead className="text-right">{t("quantity")}</TableHead>
                    <TableHead className="text-right">{t("unitPrice")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.lines.map((line) => (
                    <TableRow key={line.lineNumber}>
                      <TableCell>
                        {line.itemName}
                        {line.description ? (
                          <span className="block text-xs text-slate-500">{line.description}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {plainDecimal(line.quantity)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.money(line.unitPrice, job.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      ) : null}

      {tab === "visits" ? (
        <Section
          title={t("tabs.visits")}
          action={
            detail.canManage && job.status === "open" && !addingVisit ? (
              <Button size="sm" variant="outline" onClick={() => setAddingVisit(true)}>
                {t("addVisit")}
              </Button>
            ) : null
          }
        >
          {addingVisit ? (
            <VisitPlanForm
              defaultMinutes={job.estimatedMinutes}
              onCancel={() => setAddingVisit(false)}
              onSubmit={(visit) =>
                run(async () => {
                  await postJson(
                    `/api/service/jobs/${job.id}/visits`,
                    { expectedRevision: job.revision, visit },
                    t("actionFailed"),
                  );
                  setAddingVisit(false);
                })
              }
            />
          ) : null}
          <VisitList visits={detail.visits} onOpen={onOpenVisit} />
        </Section>
      ) : null}

      {tab === "billing" ? <BillingTab detail={detail} run={run} busy={busy} /> : null}
    </div>
  );
}

function BillingTab({
  detail,
  run,
  busy,
}: {
  detail: ServiceJobDetail;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const t = useTranslations("service.job");
  const f = useServiceFormat();
  const { job } = detail;
  const [preview, setPreview] = useState<{ visitId: string | null; plan: InvoicePreview } | null>(
    null,
  );
  const [candidates, setCandidates] = useState<DepositCandidate[] | null>(null);
  const [paymentId, setPaymentId] = useState("");
  const [refusal, setRefusal] = useState<Refused>(null);
  const live = detail.billings.filter((billing) => !billing.releasedAt);
  const billableVisits = detail.visits.filter(
    (visit) =>
      visit.status === "completed" &&
      !visit.invoice &&
      (visit.reviewStatus === null ||
        visit.reviewStatus === "not_required" ||
        visit.reviewStatus === "approved"),
  );

  async function showPreview(visitId: string | null) {
    setRefusal(null);
    try {
      const plan = await serviceRequest<InvoicePreview>(
        `/api/service/jobs/${job.id}/invoice${visitId ? `?visit=${visitId}` : ""}`,
        undefined,
        t("actionFailed"),
      );
      setPreview({ visitId, plan });
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    }
  }

  async function loadCandidates() {
    setRefusal(null);
    try {
      const result = await serviceRequest<{ candidates: DepositCandidate[] }>(
        `/api/service/jobs/${job.id}/deposits`,
        undefined,
        t("actionFailed"),
      );
      setCandidates(result.candidates);
      setPaymentId(result.candidates[0]?.paymentDocumentId ?? "");
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    }
  }

  return (
    <div className="space-y-5">
      <Refusal refusal={refusal} />
      <dl className="grid gap-3 sm:grid-cols-3">
        <Field label={t("billingMode")}>{t(`billingModes.${job.billingMode}`)}</Field>
        <Field label={t("depositRequired")}>{f.money(job.depositRequired, job.currency)}</Field>
        <Field label={t("depositsReceived")}>
          {detail.deposits.length
            ? detail.deposits.map((deposit) => f.money(deposit.amount, job.currency)).join(" + ")
            : "—"}
        </Field>
      </dl>

      <Section
        title={t("invoices")}
        action={
          detail.canInvoice && job.billingMode !== "not_billable" ? (
            <div className="flex gap-1.5">
              {job.billingMode === "per_job" &&
              job.status === "completed" &&
              !live.some((billing) => billing.visitId === null) ? (
                <Button size="sm" variant="outline" onClick={() => void showPreview(null)}>
                  {t("invoiceJob")}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {job.billingMode === "per_visit" && detail.canInvoice && billableVisits.length ? (
          <ul className="space-y-1">
            {billableVisits.map((visit) => (
              <li key={visit.id} className="flex items-center justify-between text-sm">
                <span>
                  {t("visitNumber", { sequence: visit.sequence })} · {f.instant(visit.completedAt)}
                </span>
                <Button size="sm" variant="outline" onClick={() => void showPreview(visit.id)}>
                  {t("invoiceVisit")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {preview ? (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <p className="text-sm font-medium">{t("preview")}</p>
            <ul className="text-sm">
              {preview.plan.lines.map((line, index) => (
                <li key={index} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {line.description ?? "—"} · {plainDecimal(line.quantity)} ×{" "}
                    {f.money(line.unitPrice, preview.plan.currency)}
                  </span>
                  <span className="tabular-nums">
                    {f.money(line.amount, preview.plan.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="flex justify-between border-t border-slate-200 pt-1 text-sm font-semibold dark:border-slate-800">
              <span>{t("subtotal")}</span>
              <span className="tabular-nums">
                {f.money(preview.plan.total, preview.plan.currency)}
              </span>
            </p>
            <p className="text-xs text-slate-500">{t("previewHelp")}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await postJson(
                      `/api/service/jobs/${job.id}/invoice`,
                      { visitId: preview.visitId },
                      t("actionFailed"),
                    );
                    setPreview(null);
                  })
                }
              >
                {t("createInvoice")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                {t("discard")}
              </Button>
            </div>
          </div>
        ) : null}
        {live.length ? (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {live.map((billing) => (
              <li key={billing.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  <Link
                    className="text-teal-700 hover:underline dark:text-teal-300"
                    href={`/ar/invoices?doc=${billing.invoiceId}`}
                  >
                    {billing.documentNumber}
                  </Link>{" "}
                  ·{" "}
                  {INVOICE_STATUSES.has(billing.status)
                    ? t(`invoiceStatus.${billing.status}`)
                    : billing.status}
                  {billing.visitId ? ` · ${t("visitInvoice")}` : ""}
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {f.money(billing.total, job.currency)}
                  {detail.canInvoice && billing.status === "posted" && detail.deposits.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          postJson(
                            `/api/service/jobs/${job.id}/deposits/apply`,
                            { invoiceDocumentId: billing.invoiceId },
                            t("actionFailed"),
                          ),
                        )
                      }
                    >
                      {t("applyDeposits")}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">{t("noInvoices")}</p>
        )}
      </Section>

      <Section
        title={t("deposits")}
        action={
          detail.canManage && job.status !== "cancelled" && candidates === null ? (
            <Button size="sm" variant="outline" onClick={() => void loadCandidates()}>
              {t("recordDeposit")}
            </Button>
          ) : null
        }
      >
        {detail.deposits.length ? (
          <ul className="text-sm">
            {detail.deposits.map((deposit) => (
              <li key={deposit.id} className="flex justify-between">
                <Link
                  className="text-teal-700 hover:underline dark:text-teal-300"
                  href={`/receipts?payment=${deposit.paymentDocumentId}`}
                >
                  {deposit.documentNumber}
                </Link>
                <span className="tabular-nums">{f.money(deposit.amount, job.currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">{t("noDeposits")}</p>
        )}
        {candidates !== null ? (
          candidates.length === 0 ? (
            <p className="text-sm text-slate-500">{t("noCandidates")}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Label>{t("payment")}</Label>
                <Select
                  value={paymentId}
                  onChange={(event) => setPaymentId(event.target.value)}
                  aria-label={t("payment")}
                >
                  {candidates.map((candidate) => (
                    <option key={candidate.paymentDocumentId} value={candidate.paymentDocumentId}>
                      {candidate.documentNumber ?? candidate.paymentDocumentId} ·{" "}
                      {f.date(candidate.postingDate)} ·{" "}
                      {f.money(candidate.open, candidate.currency)}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                size="sm"
                disabled={busy || !paymentId}
                onClick={() =>
                  void run(async () => {
                    await postJson(
                      `/api/service/jobs/${job.id}/deposits`,
                      { paymentDocumentId: paymentId },
                      t("actionFailed"),
                    );
                    setCandidates(null);
                  })
                }
              >
                {t("linkDeposit")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCandidates(null)}>
                {t("discard")}
              </Button>
            </div>
          )
        ) : null}
        <p className="text-xs text-slate-500">{t("depositHelp")}</p>
      </Section>
    </div>
  );
}

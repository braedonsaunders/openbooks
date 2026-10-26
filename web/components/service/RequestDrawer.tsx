"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select } from "@openbooks/ui";
import type { ServiceQuoteSummary, ServiceRequestDetail } from "@openbooks/engine/service/reads";
import { promptDialog } from "../../lib/prompt";
import { postJson, refusalText, serviceRequest } from "./api";
import {
  Field,
  PriorityBadge,
  RecordStatusBadge,
  Refusal,
  Section,
  useServiceFormat,
} from "./format";
import { VisitList, VisitPlanForm } from "./visit-list";

type Refused = { message: string; remedy: string | null } | null;
type EstimateLine = {
  id: string;
  line_number: number;
  item_name: string | null;
  description: string | null;
  quantity: string;
  amount: string;
};

const OPEN = new Set(["new", "assessment_scheduled", "assessed", "quoted"]);

/** A service request: what was asked for, its assessment visits and its quotes. */
export function ServiceRequestBody({
  detail,
  reload,
  onOpenVisit,
  onOpenJob,
}: {
  detail: ServiceRequestDetail;
  reload: () => void;
  onOpenVisit: (visitId: string) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const t = useTranslations("service.request");
  const f = useServiceFormat();
  const { request } = detail;
  const open = OPEN.has(request.status);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);
  const [assessing, setAssessing] = useState(false);
  const [converting, setConverting] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setRefusal(null);
    try {
      await action();
      reload();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function close(outcome: "declined" | "cancelled") {
    const reason = await promptDialog({
      title: t(`${outcome}.title`),
      label: t(`${outcome}.reason`),
      multiline: true,
      confirmLabel: t(`${outcome}.confirm`),
    });
    if (!reason) return;
    await run(() =>
      postJson(
        `/api/service/requests/${request.id}/close`,
        { expectedRevision: request.revision, outcome, reason },
        t("actionFailed"),
      ),
    );
  }

  async function startQuote() {
    await run(async () => {
      const quote = await postJson<{ quoteDocumentId: string }>(
        `/api/service/requests/${request.id}/quote`,
        { idempotencyKey: crypto.randomUUID() },
        t("actionFailed"),
      );
      window.open(`/estimates?estimate=${quote.quoteDocumentId}`, "_blank", "noopener");
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <RecordStatusBadge status={request.status} family="request" />
        <PriorityBadge priority={request.priority} />
        <span className="text-xs text-slate-500">{t(`source.${request.source}`)}</span>
        {detail.canManage && open ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => setConverting(true)}>
              {t("convert")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void startQuote()}>
              {t("quote")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void close("declined")}
            >
              {t("declined.action")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void close("cancelled")}
            >
              {t("cancelled.action")}
            </Button>
          </div>
        ) : null}
      </div>
      <Refusal refusal={refusal} />
      {converting ? (
        <ConvertForm
          title={request.title}
          onCancel={() => setConverting(false)}
          onSubmit={(input) =>
            run(async () => {
              const created = await postJson<{ job: { id: string } }>(
                "/api/service/jobs",
                { id: crypto.randomUUID(), requestId: request.id, ...input, firstVisit: {} },
                t("actionFailed"),
              );
              setConverting(false);
              onOpenJob(created.job.id);
            })
          }
        />
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label={t("customer")}>{request.customerName}</Field>
        <Field label={t("address")}>{request.address ?? "—"}</Field>
        <Field label={t("contact")}>
          {[request.contactName, request.contactPhone, request.contactEmail]
            .filter(Boolean)
            .join(" · ") || "—"}
        </Field>
        <Field label={t("preferred")}>
          {request.preferredOn ? f.date(request.preferredOn) : "—"} ·{" "}
          {t(`time.${request.preferredTime}`)}
        </Field>
        <Field label={t("received")}>{f.instant(request.createdAt)}</Field>
        {detail.job ? (
          <Field label={t("job")}>
            <button
              type="button"
              className="text-teal-700 hover:underline dark:text-teal-300"
              onClick={() => onOpenJob(detail.job!.id)}
            >
              {detail.job.jobNumber}
            </button>
          </Field>
        ) : null}
        {request.closeReason ? <Field label={t("closeReason")}>{request.closeReason}</Field> : null}
      </dl>
      {request.description ? (
        <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
          {request.description}
        </p>
      ) : null}

      <Section
        title={t("assessments")}
        action={
          detail.canManage && open && !assessing ? (
            <Button size="sm" variant="outline" onClick={() => setAssessing(true)}>
              {t("addAssessment")}
            </Button>
          ) : null
        }
      >
        {assessing ? (
          <VisitPlanForm
            defaultMinutes={60}
            onCancel={() => setAssessing(false)}
            onSubmit={(visit) =>
              run(async () => {
                await postJson(
                  `/api/service/requests/${request.id}/assessment`,
                  { expectedRevision: request.revision, visit },
                  t("actionFailed"),
                );
                setAssessing(false);
              })
            }
          />
        ) : null}
        <VisitList visits={detail.visits} onOpen={onOpenVisit} />
      </Section>

      <Section title={t("quotes")}>
        {detail.quotes.length === 0 ? (
          <p className="text-sm text-slate-500">{t("noQuotes")}</p>
        ) : (
          detail.quotes.map((quote) => (
            <QuoteCard
              key={quote.quoteDocumentId}
              quote={quote}
              canManage={detail.canManage}
              run={run}
              busy={busy}
              onOpenJob={onOpenJob}
              title={request.title}
            />
          ))
        )}
      </Section>
    </div>
  );
}

type ConvertInput = { estimatedMinutes: number; billingMode: string; title?: string };

function ConvertForm({
  title,
  onSubmit,
  onCancel,
}: {
  title: string;
  onSubmit: (input: ConvertInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("service.form");
  const [minutes, setMinutes] = useState("60");
  const [mode, setMode] = useState("per_visit");
  const [jobTitle, setJobTitle] = useState(title);
  return (
    <div className="grid gap-3 rounded-lg border border-teal-200 p-3 sm:grid-cols-3 dark:border-teal-900">
      <div className="sm:col-span-3">
        <Label>{t("title")}</Label>
        <Input
          value={jobTitle}
          onChange={(event) => setJobTitle(event.target.value)}
          aria-label={t("title")}
        />
      </div>
      <div>
        <Label>{t("estimatedMinutes")}</Label>
        <Input
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          aria-label={t("estimatedMinutes")}
        />
      </div>
      <div className="sm:col-span-2">
        <Label>{t("billingMode")}</Label>
        <Select
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          aria-label={t("billingMode")}
        >
          {(["per_visit", "per_job", "not_billable"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`billingModes.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2 sm:col-span-3">
        <Button
          size="sm"
          disabled={!/^\d+$/.test(minutes.trim()) || !jobTitle.trim()}
          onClick={() =>
            void onSubmit({
              estimatedMinutes: Number(minutes.trim()),
              billingMode: mode,
              title: jobTitle.trim(),
            })
          }
        >
          {t("createJob")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}

function QuoteCard({
  quote,
  canManage,
  run,
  busy,
  onOpenJob,
  title,
}: {
  quote: ServiceQuoteSummary;
  canManage: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  onOpenJob: (jobId: string) => void;
  title: string;
}) {
  const t = useTranslations("service.quote");
  const f = useServiceFormat();
  const [editing, setEditing] = useState<{
    lines: EstimateLine[];
    optional: Set<string>;
    basis: string;
    value: string;
  } | null>(null);
  const [converting, setConverting] = useState(false);
  const [sent, setSent] = useState<{
    link: string;
    emailed: boolean;
    emailSkippedReason: string | null;
  } | null>(null);
  const [refusal, setRefusal] = useState<Refused>(null);

  async function edit() {
    setRefusal(null);
    try {
      const estimate = await serviceRequest<{ lines: EstimateLine[] }>(
        `/api/estimates/${quote.quoteDocumentId}`,
        undefined,
        t("loadFailed"),
      );
      setEditing({
        lines: estimate.lines,
        optional: new Set(quote.optionalLineIds),
        basis: quote.depositBasis,
        value: quote.depositBasis === "none" ? "" : quote.depositValue,
      });
    } catch (error) {
      setRefusal(refusalText(error, t("loadFailed")));
    }
  }

  async function send() {
    const signerName = await promptDialog({ title: t("send.title"), label: t("send.signerName") });
    if (!signerName) return;
    const signerEmail = await promptDialog({
      title: t("send.title"),
      label: t("send.signerEmail"),
    });
    if (!signerEmail) return;
    await run(async () =>
      setSent(
        await postJson(
          `/api/service/quotes/${quote.quoteDocumentId}/send`,
          { signerName, signerEmail },
          t("actionFailed"),
        ),
      ),
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          href={`/estimates?estimate=${quote.quoteDocumentId}`}
          target="_blank"
        >
          {quote.documentNumber}
        </Link>
        <RecordStatusBadge status={quote.status} family="quote" />
        <span className="tabular-nums text-slate-600 dark:text-slate-300">
          {f.money(quote.acceptedTotal ?? quote.total, quote.currency)}
        </span>
        {quote.depositDue ? (
          <span className="text-xs text-slate-500">
            {t("depositDue", { amount: f.money(quote.depositDue, quote.currency) })}
          </span>
        ) : null}
        {canManage ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {quote.status === "draft" ||
            (quote.status === "sent" &&
              quote.signatureStatus !== "sent" &&
              quote.signatureStatus !== "viewed") ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void edit()}>
                {t("terms")}
              </Button>
            ) : null}
            {quote.status === "draft" ? (
              <Button size="sm" disabled={busy} onClick={() => void send()}>
                {t("send.action")}
              </Button>
            ) : null}
            {quote.status === "accepted" && !quote.jobId ? (
              <Button size="sm" disabled={busy} onClick={() => setConverting(true)}>
                {t("convert")}
              </Button>
            ) : null}
            {quote.jobId ? (
              <Button size="sm" variant="ghost" onClick={() => onOpenJob(quote.jobId!)}>
                {t("openJob")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {quote.estimateStatus === "draft" && quote.status === "draft" ? (
        <p className="text-xs text-slate-500">{t("issueFirst")}</p>
      ) : null}
      {quote.decidedName ? (
        <p className="text-xs text-slate-500">
          {t("decided", { name: quote.decidedName, when: f.instant(quote.decidedAt) })}
        </p>
      ) : quote.sentAt ? (
        <p className="text-xs text-slate-500">
          {t("sentAt", { when: f.instant(quote.sentAt), expires: f.instant(quote.expiresAt) })}
        </p>
      ) : null}
      <Refusal refusal={refusal} />
      {sent ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          {sent.emailed
            ? t("send.emailed")
            : t("send.notEmailed", { reason: sent.emailSkippedReason ?? "" })}{" "}
          <a
            className="break-all text-teal-700 underline dark:text-teal-300"
            href={sent.link}
            target="_blank"
            rel="noreferrer"
          >
            {t("send.link")}
          </a>
        </p>
      ) : null}
      {editing ? (
        <div className="space-y-2 border-t border-slate-200 pt-2 dark:border-slate-800">
          <p className="text-xs text-slate-500">{t("optionalHelp")}</p>
          <ul className="space-y-1">
            {editing.lines.map((line) => (
              <li key={line.id} className="flex items-center justify-between gap-2 text-sm">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editing.optional.has(line.id)}
                    onChange={(event) =>
                      setEditing((current) => {
                        if (!current) return current;
                        const optional = new Set(current.optional);
                        if (event.target.checked) optional.add(line.id);
                        else optional.delete(line.id);
                        return { ...current, optional };
                      })
                    }
                  />
                  <span className="truncate">
                    {line.item_name ?? line.description ?? `#${line.line_number}`}
                  </span>
                </label>
                <span className="tabular-nums text-slate-600">
                  {f.money(line.amount, quote.currency)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label>{t("deposit")}</Label>
              <Select
                value={editing.basis}
                onChange={(event) =>
                  setEditing((current) => current && { ...current, basis: event.target.value })
                }
                aria-label={t("deposit")}
              >
                {(["none", "percent", "amount"] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`depositBasis.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            {editing.basis !== "none" ? (
              <div>
                <Label>{t(editing.basis === "percent" ? "depositPercent" : "depositAmount")}</Label>
                <Input
                  inputMode="decimal"
                  value={editing.value}
                  onChange={(event) =>
                    setEditing((current) => current && { ...current, value: event.target.value })
                  }
                  aria-label={t("deposit")}
                />
              </div>
            ) : null}
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await postJson(
                    `/api/service/quotes/${quote.quoteDocumentId}`,
                    {
                      depositBasis: editing.basis,
                      depositValue: editing.basis === "none" ? "0" : editing.value.trim(),
                      optionalLineIds: [...editing.optional],
                    },
                    t("actionFailed"),
                    "PUT",
                  );
                  setEditing(null);
                })
              }
            >
              {t("saveTerms")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t("discard")}
            </Button>
          </div>
        </div>
      ) : null}
      {converting ? (
        <ConvertForm
          title={title}
          onCancel={() => setConverting(false)}
          onSubmit={(input) =>
            run(async () => {
              const created = await postJson<{ job: { id: string } }>(
                `/api/service/quotes/${quote.quoteDocumentId}/convert`,
                { id: crypto.randomUUID(), ...input },
                t("actionFailed"),
              );
              setConverting(false);
              onOpenJob(created.job.id);
            })
          }
        />
      ) : null}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import type { ServiceAgreementDetail } from "@openbooks/engine/service/reads";
import { promptDialog } from "../../lib/prompt";
import { postJson, refusalText } from "./api";
import {
  Field,
  RecordStatusBadge,
  Refusal,
  Section,
  plainDecimal,
  useServiceFormat,
} from "./format";
import { AgreementTermsForm, type AgreementTerms } from "./agreement-terms";
import { VisitList } from "./visit-list";

type Refused = { message: string; remedy: string | null } | null;

/** A recurring service agreement: its effective-dated terms and the visits they generated. */
export function ServiceAgreementBody({
  detail,
  reload,
  onOpenVisit,
  onOpenJob,
}: {
  detail: ServiceAgreementDetail;
  reload: () => void;
  onOpenVisit: (visitId: string) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const t = useTranslations("service.agreement");
  const f = useServiceFormat();
  const { agreement } = detail;
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);
  const [versioning, setVersioning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = detail.versions.at(-1);

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

  async function close(outcome: "ended" | "cancelled") {
    const reason = await promptDialog({
      title: t(`${outcome}.title`),
      label: t(`${outcome}.reason`),
      multiline: true,
      confirmLabel: t(`${outcome}.confirm`),
    });
    if (!reason) return;
    await run(() =>
      postJson(
        `/api/service/agreements/${agreement.id}/close`,
        { expectedRevision: agreement.revision, outcome, reason },
        t("actionFailed"),
      ),
    );
  }

  async function addVersion(terms: AgreementTerms & { effectiveFrom: string; reason: string }) {
    const { effectiveFrom, reason, ...version } = terms;
    await run(async () => {
      await postJson(
        `/api/service/agreements/${agreement.id}/versions`,
        { expectedRevision: agreement.revision, effectiveFrom, reason, version },
        t("actionFailed"),
      );
      setVersioning(false);
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <RecordStatusBadge status={agreement.status} family="agreement" />
        {detail.canManage && agreement.status === "active" ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await postJson<{ generated: number }>(
                    `/api/service/agreements/${agreement.id}/generate`,
                    {},
                    t("actionFailed"),
                  );
                  setNotice(t("generated", { count: result.generated }));
                })
              }
            >
              {t("generate")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setVersioning(true)}>
              {t("newVersion")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void close("ended")}>
              {t("ended.action")}
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
      {notice ? (
        <p role="status" className="text-sm text-teal-700 dark:text-teal-300">
          {notice}
        </p>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label={t("customer")}>{agreement.customerName}</Field>
        <Field label={t("address")}>{agreement.address ?? "—"}</Field>
        <Field label={t("term")}>
          {f.date(agreement.startsOn)} –{" "}
          {agreement.endsOn ? f.date(agreement.endsOn) : t("openEnded")}
        </Field>
        <Field label={t("generatedThrough")}>
          {agreement.generatedThrough ? f.date(agreement.generatedThrough) : "—"}
        </Field>
        {agreement.jobId ? (
          <Field label={t("job")}>
            <button
              type="button"
              className="text-teal-700 hover:underline dark:text-teal-300"
              onClick={() => onOpenJob(agreement.jobId!)}
            >
              {agreement.jobNumber}
            </button>
          </Field>
        ) : null}
        {agreement.closeReason ? (
          <Field label={t("closeReason")}>{agreement.closeReason}</Field>
        ) : null}
      </dl>
      {versioning && current ? (
        <AgreementTermsForm
          withEffectiveDate
          initial={current}
          onCancel={() => setVersioning(false)}
          onSubmit={addVersion}
        />
      ) : null}
      <Section title={t("versions")}>
        <ul className="space-y-2">
          {detail.versions.map((version) => {
            const rule = version.recurrence as {
              repeat?: string;
              interval?: number;
              weekdays?: number[];
            };
            return (
              <li
                key={version.id}
                className="rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-800"
              >
                <p className="font-medium">
                  {t("effectiveFrom", { date: f.date(version.effectiveFrom) })}
                </p>
                <p className="text-slate-600 dark:text-slate-300">
                  {t(`repeat.${rule.repeat ?? "weekly"}`, { interval: rule.interval ?? 1 })} ·{" "}
                  {version.windowStarts}–{version.windowEnds} ·{" "}
                  {f.minutes(version.estimatedMinutes)}
                </p>
                {version.lines.length ? (
                  <p className="text-xs text-slate-500">
                    {version.lines
                      .map((line) => `${line.itemName} × ${plainDecimal(line.quantity)}`)
                      .join(", ")}
                  </p>
                ) : null}
                <p className="text-xs text-slate-400">{version.reason}</p>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={t("visits")}>
        <VisitList visits={detail.visits} onOpen={onOpenVisit} />
      </Section>
    </div>
  );
}

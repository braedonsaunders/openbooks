"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { ApprovalActions } from "@/components/approval-actions";
import { ApprovalHistory } from "@/components/approval-history";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { readApiErrorMessage } from "@/lib/api-error";
import { useViewerFormat } from "@/lib/viewer-format";
import { formatDecimal } from "@/lib/money-format";
import type { ApprovalRequestDetail } from "../../api/flows/records/[subjectKind]/[id]/route";

/** One native drawer retains identity, focus and refusals throughout the request. */
export function ApprovalRequestHost() {
  const params = useSearchParams();
  const pathname = usePathname();
  const id = params.get("review");
  const kind = params.get("reviewKind");
  const t = useTranslations("common");
  const format = useViewerFormat();
  const identity = `${kind ?? ""}:${id ?? ""}`;
  const [loaded, setLoaded] = useState<ApprovalRequestDetail | null>(null);
  const [failure, setFailure] = useState<{
    identity: string;
    message: string;
    retryable: boolean;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<"terms" | "history">("terms");
  const invalid = !!id && (!isUuid(id) || !kind || !/^[a-z][a-z0-9_]{0,99}$/.test(kind));
  const detail = loaded?.subjectId === id && loaded.subjectKind === kind ? loaded : null;
  const error = failure?.identity === identity ? failure : null;
  const closeParams = new URLSearchParams(params.toString());
  closeParams.delete("review");
  closeParams.delete("reviewKind");
  const query = closeParams.toString();
  const closeHref = query ? `${pathname}?${query}` : pathname;

  useEffect(() => {
    if (!id || !kind || invalid) return;
    const controller = new AbortController();
    fetch(`/api/flows/records/${encodeURIComponent(kind)}/${id}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          const message = await readApiErrorMessage(
            response,
            t("approvalFlow.recordReview.unavailable"),
          );
          if (!controller.signal.aborted)
            setFailure({ identity, message, retryable: response.status >= 500 });
          return;
        }
        const value = (await response.json()) as ApprovalRequestDetail;
        if (
          value.subjectId !== id ||
          value.subjectKind !== kind ||
          typeof value.changed !== "boolean" ||
          (value.submittedAt !== null &&
            (typeof value.submittedAt !== "string" ||
              !Number.isFinite(Date.parse(value.submittedAt)))) ||
          !Array.isArray(value.fields) ||
          !value.fields.every(
            (field) =>
              field &&
              typeof field.key === "string" &&
              typeof field.label === "string" &&
              typeof field.type === "string" &&
              (field.value === null ||
                ["string", "number", "boolean"].includes(typeof field.value)),
          )
        ) {
          throw new Error(t("approvalFlow.recordReview.unavailable"));
        }
        if (!controller.signal.aborted) {
          setLoaded(value);
          setFailure(null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            identity,
            message:
              cause instanceof Error ? cause.message : t("approvalFlow.recordReview.unavailable"),
            retryable: true,
          });
      });
    return () => controller.abort();
  }, [id, kind, identity, invalid, retry, t]);

  if (!id) return null;
  const fieldLabel = (field: ApprovalRequestDetail["fields"][number]) => {
    if (t.has(`approvalFlow.recordReview.fields.${field.key}`))
      return t(`approvalFlow.recordReview.fields.${field.key}`);
    if (t.has(`labels.${field.key}`)) return t(`labels.${field.key}`);
    return t(`approvalFlow.recordReview.fields.${field.key}`);
  };
  const fieldValue = (field: ApprovalRequestDetail["fields"][number]) => {
    if (field.value === null) return t("labels.notSet");
    if (typeof field.value === "boolean") return t(field.value ? "labels.yes" : "labels.no");
    const value = String(field.value);
    if (field.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return format.civilDate(value);
    if (field.type === "number" && /^-?\d+(?:\.\d+)?$/.test(value))
      return formatDecimal(format.locale, value, {
        maximumFractionDigits: value.split(".")[1]?.length ?? 0,
      });
    if (field.key === "status" && t.has(`status.${value}`)) return t(`status.${value}`);
    if (field.key === "commandAction" && t.has(`actions.${value}`)) return t(`actions.${value}`);
    return value;
  };
  return (
    <AsyncUrlDrawer
      open
      openKey={identity}
      closeHref={closeHref}
      title={t("approvalFlow.recordReview.title")}
      pending={!detail && !error && !invalid}
      error={invalid ? t("approvalFlow.recordReview.unavailable") : error?.message}
      onRetry={
        error?.retryable
          ? () => {
              setFailure(null);
              setRetry((value) => value + 1);
            }
          : undefined
      }
      footer={
        detail && !error && !invalid ? (
          <ApprovalActions subjectKind={kind!} subjectId={id} decisionDisabled={detail.changed} />
        ) : undefined
      }
    >
      {detail ? (
        <div className="space-y-4">
          {detail.changed ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {t("approvalFlow.recordReview.changed")}
            </p>
          ) : null}
          <RecordTabs
            label={t("approvalFlow.recordReview.title")}
            active={tab}
            onChange={setTab}
            tabs={[
              {
                key: "terms",
                label: t(
                  detail.submittedAt
                    ? "approvalFlow.recordReview.terms"
                    : "approvalFlow.recordReview.currentTerms",
                ),
              },
              { key: "history", label: t("approvalFlow.historyTitle") },
            ]}
          />
          {tab === "terms" ? (
            <>
              {detail.submittedAt ? (
                <p className="text-xs text-slate-500">{format.dateTime(detail.submittedAt)}</p>
              ) : null}
              <dl className="grid gap-4 sm:grid-cols-2">
                {detail.fields.map((field) => (
                  <div key={field.key}>
                    <dt className="text-xs text-slate-500">{fieldLabel(field)}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sm">{fieldValue(field)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <ApprovalHistory subjectKind={kind!} subjectId={id} showEmptyState />
          )}
        </div>
      ) : null}
    </AsyncUrlDrawer>
  );
}

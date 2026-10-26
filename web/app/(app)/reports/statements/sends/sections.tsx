"use client";

import { useIdentityState } from "@/lib/use-identity-state";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@openbooks/ui";
import { AsyncUrlDrawer } from "../../../../../components/async-url-drawer";
import { readApiErrorMessage } from "../../../../../lib/api-error";

interface RunItem {
  partyId: string;
  partyName: string | null;
  toEmail: string | null;
  balance: string;
  overdue: string;
  currency: string | null;
  status: "queued" | "sending" | "sent" | "failed" | "skipped";
  error: string | null;
  sentAt: string | null;
}

interface RunDetail {
  run: {
    id: string;
    periodFrom: string | null;
    periodTo: string;
    recipientCount: number;
    status: string;
    counts: { queued: number; sent: number; failed: number; skipped: number };
  };
  items: RunItem[];
}

/**
 * The run detail drawer: per-customer delivery state with its error, and
 * Retry failed. The list stays mounted behind it; closing returns to the
 * run list.
 */
export function StatementBatchRunDrawer({ runId }: { runId: string | null }) {
  const router = useRouter();
  const t = useTranslations("reports.statementBatch");
  const [generation, setGeneration] = useState(0);
  const [detail, setDetail] = useIdentityState<RunDetail | null>([runId, generation], null);
  const [failure, setFailure] = useIdentityState<string | null>([runId, generation], null);
  const [pending, setPending] = useIdentityState([runId, generation], Boolean(runId));
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    fetch(`/api/statement-batches/${encodeURIComponent(runId)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, "loadFailed"));
        }
        return (await response.json()) as RunDetail;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setDetail(data);
        setPending(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : "loadFailed");
        setPending(false);
      });
    return () => controller.abort();
  }, [runId, generation, setDetail, setPending, setFailure]);

  if (!runId) return null;
  const statusLabel = (status: string): string => {
    if (status === "sent") return t("statusSent");
    if (status === "failed") return t("statusFailed");
    if (status === "skipped") return t("statusSkipped");
    if (status === "sending") return t("statusSending");
    return t("statusQueued");
  };
  const period = detail?.run.periodFrom
    ? `${detail.run.periodFrom} → ${detail.run.periodTo}`
    : (detail?.run.periodTo ?? "");
  return (
    <AsyncUrlDrawer
      open
      openKey={runId}
      closeHref="/reports/statements/sends"
      title={t("sendsTitle")}
      description={period}
      pending={pending}
      error={failure}
      onRetry={() => setGeneration((n) => n + 1)}
    >
      {detail ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-4 gap-2 text-sm">
            <div>
              <dt className="text-xs text-slate-500">{t("columnRecipients")}</dt>
              <dd className="font-medium tabular-nums">{detail.run.recipientCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t("columnSent")}</dt>
              <dd className="font-medium tabular-nums">{detail.run.counts.sent}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t("columnFailed")}</dt>
              <dd className="font-medium tabular-nums">{detail.run.counts.failed}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t("columnSkipped")}</dt>
              <dd className="font-medium tabular-nums">{detail.run.counts.skipped}</dd>
            </div>
          </dl>
          <Table
            containerClassName="overflow-visible rounded-none border-0 bg-transparent shadow-none"
            className="w-full text-sm"
          >
            <TableHeader>
              <TableRow noAnimate className="border-b text-left text-xs text-slate-500">
                <TableHead className="py-1.5 pr-2 font-medium">{t("columnCustomer")}</TableHead>
                <TableHead className="py-1.5 pr-2 text-right font-medium">
                  {t("columnBalance")}
                </TableHead>
                <TableHead className="py-1.5 pr-2 font-medium">{t("columnStatus")}</TableHead>
                <TableHead className="py-1.5 font-medium">{t("columnError")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.items.map((item) => (
                <TableRow noAnimate key={item.partyId} className="border-b last:border-0">
                  <TableCell className="py-1.5 pr-2">
                    <div className="font-medium">{item.partyName ?? item.partyId}</div>
                    <div className="text-xs text-slate-500">
                      {item.toEmail ?? t("exclusionsTitle")}
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5 pr-2 text-right tabular-nums">
                    {item.balance}
                  </TableCell>
                  <TableCell className="py-1.5 pr-2">{statusLabel(item.status)}</TableCell>
                  <TableCell className="py-1.5 text-xs text-slate-500">
                    {item.error ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {detail.run.counts.failed > 0 ? (
            <span className="inline-flex flex-col gap-1">
              <Button
                variant="outline"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  setRetryError(null);
                  try {
                    const res = await fetch(
                      `/api/statement-batches/${encodeURIComponent(runId)}/retry`,
                      { method: "POST" },
                    );
                    if (!res.ok) throw new Error(await readApiErrorMessage(res, t("retryButton")));
                    router.refresh();
                    setGeneration((n) => n + 1);
                  } catch (e) {
                    setRetryError(e instanceof Error ? e.message : t("retryButton"));
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                {retrying ? t("retrying") : t("retryButton")}
              </Button>
              {retryError ? (
                <span className="text-xs text-red-600 dark:text-red-400">{retryError}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </AsyncUrlDrawer>
  );
}

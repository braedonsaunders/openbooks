"use client";

import { useIdentityState } from "@/lib/use-identity-state";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DisclosureSection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { AlertTriangle, Check, Play, RefreshCw } from "lucide-react";
import { useMoney } from "@/components/money-provider";
import { refusalMessageFromBody } from "../../../lib/api-error";

/** The preview the accrual engine returns for one period, with its period
 *  names already labelled in the viewer's locale by the route. */
type AccrualPreview = {
  period: { id: string; name: string; startsOn: string; endsOn: string };
  reversal: { periodId: string | null; periodName: string | null; date: string | null };
  totals: { currency: string; unbilled: string; accrued: string; delta: string }[];
  projectCount: number;
  lines: {
    projectId: string;
    projectCode: string | null;
    projectName: string;
    currency: string;
    revenueAccountId: string;
    unbilled: string;
    accrued: string;
    delta: string;
  }[];
  upToDate: boolean;
  problems: { code: string; message: string; projectId?: string }[];
};

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; preview: AccrualPreview };

async function readError(response: Response, fallback: string): Promise<string> {
  // The refusal reads through the shared helper so message, remedy and code
  // render instead of the bare `error` field.
  const data = await response.json().catch(() => ({}));
  return refusalMessageFromBody(data, { fallback }) ?? fallback;
}

const isZero = (value: string) => /^-?0*(\.0*)?$/.test(value.trim());

/**
 * The close task's unbilled revenue accrual: what is unbilled at period end,
 * what posting would add or correct, the per-project detail behind a Review
 * disclosure, and the one action that posts it.
 */
export function UnbilledAccrualPanel({
  periodId,
  canPost,
}: {
  periodId: string;
  canPost: boolean;
}) {
  const t = useTranslations("close.unbilledAccrual");
  const router = useRouter();
  const { money } = useMoney();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useIdentityState<LoadState>([periodId, attempt], { status: "loading" });
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    return fetch(`/api/close/unbilled-revenue-accrual?periodId=${encodeURIComponent(periodId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, t("loadFailed")));
        return (await response.json()) as AccrualPreview;
      })
      .then((preview) => setState({ status: "ready", preview }))
      .catch((cause: unknown) =>
        setState({
          status: "failed",
          message: cause instanceof Error ? cause.message : t("loadFailed"),
        }),
      );
  }, [periodId, t, setState]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  async function post() {
    setPosting(true);
    try {
      const response = await fetch("/api/close/unbilled-revenue-accrual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      if (!response.ok) {
        toast.error(await readError(response, t("postFailed")));
        return;
      }
      toast.success(t("posted"));
      setAttempt((value) => value + 1);
      router.refresh();
    } catch {
      toast.error(t("postFailed"));
    } finally {
      setPosting(false);
    }
  }

  if (state.status === "loading") {
    return <p className="text-sm text-slate-500">{t("loading")}</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {state.message}
        </p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          <RefreshCw size={14} />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const { preview } = state;
  const pending = preview.totals.some((total) => !isZero(total.delta));
  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs text-slate-500">
        {preview.reversal.date
          ? t("dates", {
              period: preview.period.name,
              accrualDate: preview.period.endsOn,
              reversalDate: preview.reversal.date,
            })
          : t("datesNoReversal", {
              period: preview.period.name,
              accrualDate: preview.period.endsOn,
            })}
      </p>
      {preview.lines.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("empty")}</p>
      ) : (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">{t("unbilled")}</dt>
            {preview.totals.map((total) => (
              <dd key={total.currency} className="text-base font-semibold tabular-nums">
                {money(total.unbilled, { currency: total.currency })}
              </dd>
            ))}
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t("toPost")}</dt>
            {preview.totals.map((total) => (
              <dd key={total.currency} className="text-base font-semibold tabular-nums">
                {money(total.delta, { currency: total.currency })}
              </dd>
            ))}
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t("projectsLabel")}</dt>
            <dd className="text-base font-semibold tabular-nums">
              {t("projects", { count: preview.projectCount })}
            </dd>
          </div>
        </dl>
      )}
      {preview.problems.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle className="flex items-center gap-2">
            <AlertTriangle size={14} />
            {t("blocked")}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {preview.problems.map((problem, index) => (
                <li key={`${problem.code}-${problem.projectId ?? ""}-${index}`}>
                  {problem.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {preview.lines.length > 0 ? (
        <DisclosureSection
          title={t("review")}
          summary={t("projects", { count: preview.projectCount })}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.project")}</TableHead>
                <TableHead className="text-right">{t("columns.unbilled")}</TableHead>
                <TableHead className="text-right">{t("columns.accrued")}</TableHead>
                <TableHead className="text-right">{t("columns.toPost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.lines.map((line) => (
                <TableRow key={`${line.projectId}-${line.revenueAccountId}-${line.currency}`}>
                  <TableCell>
                    {line.projectCode
                      ? `${line.projectCode} · ${line.projectName}`
                      : line.projectName}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.unbilled, { currency: line.currency })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.accrued, { currency: line.currency })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.delta, { currency: line.currency })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DisclosureSection>
      ) : null}
      {preview.upToDate ? (
        <Badge variant="success">
          <Check size={12} />
          {t("upToDate")}
        </Badge>
      ) : canPost ? (
        <Button
          size="sm"
          disabled={posting || !pending || preview.problems.length > 0}
          onClick={() => void post()}
        >
          <Play size={14} />
          {t("post")}
        </Button>
      ) : (
        <p className="text-xs text-slate-500">{t("postPermission")}</p>
      )}
    </div>
  );
}

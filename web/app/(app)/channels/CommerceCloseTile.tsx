'use client'

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Badge, Button, Drawer } from "@openbooks/ui";
import { CockpitPanel } from "../../../components/cockpit/ui";
import { readApiErrorMessage } from "../../../lib/api-error";

interface CompletenessCheck {
  code: string;
  severity: "warning" | "error" | "critical";
  count: number;
  title: string;
  message: string;
  details: Record<string, unknown>;
}

interface CompletenessPayload {
  day: string;
  checks: CompletenessCheck[];
}

const FALLBACK_HREF: Record<string, string> = {
  "commerce-orders-incomplete": "/channels/orders",
  "commerce-storefront-unreachable": "/channels",
  "commerce-payouts-unposted": "/banking/psp-settlements",
  "commerce-clearing-residual": "/channels",
  "commerce-stored-value-gap": "/stored-value",
  "commerce-deferred-gap": "/revenue",
  "commerce-contract-cost-gap": "/revenue/contract-costs",
  "commerce-exceptions-open": "/channels/exceptions",
};

const SEVERITY_VARIANT = {
  critical: "destructive",
  error: "warning",
  warning: "secondary",
} as const;

/** First drill link buried in a check's evidence details, if any. */
function drillHref(check: CompletenessCheck): string {
  const details = check.details;
  for (const key of ["gaps", "batches", "accounts", "ties", "parked", "days"]) {
    const items = details[key];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === "object" && item !== null && typeof (item as { remedyHref?: unknown }).remedyHref === "string") {
          return (item as { remedyHref: string }).remedyHref;
        }
      }
    }
  }
  return FALLBACK_HREF[check.code] ?? "/channels";
}

/**
 * Today's completeness on the channels home: everyday state plus the next
 * action, in plain words. A clean day reads as one line; anything open
 * becomes a work queue with the reason and a drill link on each row. The
 * collapsed section names every proof and its count for the operator who
 * wants the whole picture before month-end.
 */
export function CommerceCloseTile() {
  const t = useTranslations("channels");
  const tClose = useTranslations("close");
  const tCommon = useTranslations("common");
  const [data, setData] = useState<CompletenessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);

  // State only settles in the fetch continuations, never synchronously in
  // the effect below: the initial useState(true) covers the first load and
  // the retry button re-arms it from its own handler.
  const load = useCallback(() => {
    return fetch("/api/channels/completeness", { cache: "no-store" })
      .then(async (res) => {
        // The status is checked before the body is parsed: a refusal names
        // its cause and remedy instead of becoming a parse error.
        if (!res.ok) {
          setLoadError(await readApiErrorMessage(res, t("home.completeness.loadFailed", { status: res.status })));
          setLoading(false);
          return;
        }
        setData((await res.json()) as CompletenessPayload);
        setLoadError(null);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(t("home.completeness.loadFailed", { status: "network" }));
        setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return null;
  if (loadError && !data) {
    return (
      <CockpitPanel title={t("home.completeness.title")} hint={t("home.completeness.hint")}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-500">{loadError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoadError(null);
              setLoading(true);
              void load();
            }}
          >
            {tCommon("actions.retry")}
          </Button>
        </div>
      </CockpitPanel>
    );
  }
  const checks = data?.checks ?? [];
  const open = checks.filter((check) => check.count > 0);
  // One check collection: every proof with its status, filterable to the
  // open ones. A collapsed second list is no exemption, so the drawer
  // holds a single list and the filter only narrows it.
  const visible = openOnly ? open : checks;
  // The home body keeps one collection (the channel cards): the close checks
  // live behind this summary count and open in a drawer, never as a second
  // stacked list. Every check keeps its reason and drill remedy inside.
  const checkTitle = (check: CompletenessCheck) =>
    tClose.has(`diagnostics.${check.code}.title`) ? tClose(`diagnostics.${check.code}.title`) : check.code;
  const checkMessage = (check: CompletenessCheck) =>
    tClose.has(`diagnostics.${check.code}.message`)
      ? tClose(`diagnostics.${check.code}.message`, { count: check.count })
      : null;
  return (
    <CockpitPanel title={t("home.completeness.title")} hint={t("home.completeness.hint")}>
      {open.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("home.completeness.clear")}</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Badge variant="warning">{open.length}</Badge>
            <span className="truncate">
              {t("home.completeness.proofsSummary", { count: checks.length })}
              {" · "}
              {open.map((check) => checkTitle(check)).join(", ")}
            </span>
          </p>
          <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
            {t("home.review")}
          </Button>
        </div>
      )}
      {reviewOpen ? (
        <Drawer
          open
          onClose={() => setReviewOpen(false)}
          title={t("home.completeness.title")}
          description={t("home.completeness.hint")}
          footer={
            <Button variant="outline" onClick={() => setReviewOpen(false)}>
              {tCommon("actions.done")}
            </Button>
          }
        >
          <div className="mb-2 flex gap-2">
            <Button size="sm" variant={openOnly ? "outline" : "secondary"} onClick={() => setOpenOnly(false)}>
              {tCommon("labels.all")} ({checks.length})
            </Button>
            <Button size="sm" variant={openOnly ? "secondary" : "outline"} onClick={() => setOpenOnly(true)}>
              {tCommon("status.open")} ({open.length})
            </Button>
          </div>
          {visible.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("home.completeness.clear")}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((check) => (
                <li key={check.code} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {check.count > 0 ? (
                        <Badge variant={SEVERITY_VARIANT[check.severity]}>{check.count}</Badge>
                      ) : (
                        <Badge variant="success">{t("home.completeness.proven")}</Badge>
                      )}
                      <span className="truncate">{checkTitle(check)}</span>
                    </div>
                    {check.count > 0 ? (
                      <p className="text-sm text-slate-500">{checkMessage(check)}</p>
                    ) : null}
                  </div>
                  {check.count > 0 ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={drillHref(check) as never}>{t("home.review")}</Link>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      ) : null}
    </CockpitPanel>
  );
}

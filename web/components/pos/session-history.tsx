"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { DrawerNavigateContext } from "@openbooks/ui";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { AsyncUrlDrawer } from "../async-url-drawer";
import { SessionReport } from "./drawer-panel";
import { posRequest, PosRequestError, type PosSessionSummary } from "./pos-api";

const SESSION_PARAM = "session";

/**
 * Opens one session's report in the drawer. The list stays mounted: only the
 * selected session changes in the address, through native history. The link
 * keeps a real href, so it also opens in a new tab.
 */
export function SessionOpenLink({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const next = new URLSearchParams(params.toString());
  next.set(SESSION_PARAM, sessionId);
  const href = `${pathname}?${next.toString()}`;
  return (
    <a
      href={href}
      className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        window.history.pushState(null, "", href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The selected session's X or Z report. One drawer shell holds loading,
 * the report, a refusal and retry; a stale response for a previously
 * selected session is discarded.
 */
export function PosSessionHost() {
  const params = useSearchParams();
  const pathname = usePathname();
  const t = useTranslations("pos");
  const sessionId = params.get(SESSION_PARAM);
  const [loaded, setLoaded] = useState<PosSessionSummary | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const closeParams = new URLSearchParams(params.toString());
  closeParams.delete(SESSION_PARAM);
  const query = closeParams.toString();
  const closeHref = query ? `${pathname}?${query}` : pathname;

  useEffect(() => {
    if (!sessionId || !isUuid(sessionId)) return;
    let cancelled = false;
    posRequest<{ summary: PosSessionSummary }>(
      `/api/pos/sessions/${encodeURIComponent(sessionId)}`,
      {},
      t("errors.report"),
    )
      .then((body) => {
        if (cancelled) return;
        setLoaded(body.summary);
        setFailure(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFailure({
          id: sessionId,
          message:
            cause instanceof PosRequestError
              ? [cause.message, cause.remedy].filter(Boolean).join(" ")
              : t("errors.report"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, retry, t]);

  if (!sessionId) return null;
  const summary = loaded?.session.id === sessionId ? loaded : null;
  const error = !isUuid(sessionId)
    ? t("errors.report")
    : failure?.id === sessionId
      ? failure.message
      : null;
  const title = summary
    ? summary.session.status === "closed"
      ? t("session.zTitle", { number: summary.session.sessionNumber })
      : t("session.xTitle", { number: summary.session.sessionNumber })
    : t("session.reportTitle");
  return (
    <DrawerNavigateContext.Provider value={(href) => window.history.pushState(null, "", href)}>
      <AsyncUrlDrawer
        open
        openKey={sessionId}
        pending={!summary}
        error={error}
        onRetry={() => {
          setFailure(null);
          setRetry((n) => n + 1);
        }}
        closeHref={closeHref}
        size="xl"
        title={title}
        description={
          summary
            ? t("session.reportDescription", {
                register: `${summary.register.code} · ${summary.register.name}`,
                date: summary.session.businessDate,
              })
            : undefined
        }
      >
        {summary ? <SessionReport summary={summary} /> : null}
      </AsyncUrlDrawer>
    </DrawerNavigateContext.Provider>
  );
}
